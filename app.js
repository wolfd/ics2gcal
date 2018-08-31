function handleStatus(response) {
  if (response.status >= 200 && response.status < 300) {
    return Promise.resolve(response);
  } else {
    return Promise.reject(new Error(response.statusText));
  }
}

function parseIcs(icsContent) {
  // Some servers put trailing comma in date lists, which trip up ical.js
  // output. As a courtesy we remove trailing commas as long as they do not
  // precede a folded line.
  // https://regex101.com/r/Q2VEZB/1
  const TRAILING_COMMA_PATTERN = /,\n(\S)/g;
  icsContent = icsContent.replace(TRAILING_COMMA_PATTERN, `\n$1`);
  // We also remove empty RDATE and EXDATE properties
  // https://regex101.com/r/5tWWwt/1
  const EMPTY_PROPERTY_PATTERN = /^(RDATE|EXDATE):$/gm;
  icsContent = icsContent.replace(EMPTY_PROPERTY_PATTERN, '');
  let icalData = ICAL.parse(icsContent);
  let icalRoot = new ICAL.Component(icalData);
  // ical.js does not automatically populate its TimezoneService with
  // custom time zones defined in VTIMEZONE components
  icalRoot.getAllSubcomponents("vtimezone").forEach(
    vtimezone => ICAL.TimezoneService.register(vtimezone));
  return icalRoot.getAllSubcomponents("vevent").map(
    vevent => new ICAL.Event(vevent));
}

async function authenticateAndGetOptions(interactive) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(
        undefined,
        interactive,
        undefined,
        response => {
          resolve(response);
        }
      );
    } catch (error) {
      reject(error);
    }
  });
}

async function fetchInstancesWithOriginalStart(token, calendarId, eventId,
  icalDate) {
  const timeString = icalDate.toString();
  let response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${eventId}/instances?originalStart=${encodeURIComponent(timeString)}`, {
        method: "GET",
        headers: new Headers({
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        }),
      })
    .then(handleStatus);
  let responseJson = await response.json();
  return responseJson.items;
}

async function fetchInstancesWithinBounds(token, calendarId, event,
  startTimeMin, startTimeMax) {
  let startTimeMaxUtc = ICAL.Timezone.convert_time(startTimeMax,
    startTimeMax.zone,
    ICAL.Timezone.utcTimezone);
  // The Google Calendar API demands that we provide an explicit UTC
  // offset.
  let startTimeMaxUtcString = startTimeMaxUtc.toString().replace('Z', '+00:00');
  // The 'timeMin' parameter used by the Google Calendar API gives a lower
  // bound on the end time, not the start time. We thus have to shift by the
  // duration of the event first.
  // TODO: This only works if start and end are specified in the same time
  // zone since fromDateTimeString ignores the UTC offset.
  let eventDuration = ICAL.Time.fromDateTimeString(event.end.dateTime).subtractDateTz(
    ICAL.Time.fromDateTimeString(event.start.dateTime));
  let endTimeMin = startTimeMin.clone();
  endTimeMin.addDuration(eventDuration);
  let endTimeMinUtc = ICAL.Timezone.convert_time(endTimeMin, endTimeMin.zone,
    ICAL.Timezone.utcTimezone);
  let endTimeMinUtcString = endTimeMinUtc.toString().replace('Z', '+00:00');
  let response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${event.id}/instances?timeMin=${encodeURIComponent(endTimeMinUtcString)}&timeMax=${encodeURIComponent(startTimeMaxUtcString)}`, {
        method: "GET",
        headers: new Headers({
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        }),
      })
    .then(handleStatus);
  let responseJson = await response.json();
  return responseJson.items;
}
async function cancelInstance(token, calendarId, instance) {
  instance.status = "cancelled";
  await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${instance.id}`, {
        method: "PUT",
        headers: new Headers({
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        }),
        body: JSON.stringify(instance),
      })
    .then(handleStatus);
}

async function cancelExDates(calendarId, event, exDates) {
  let {token} = await authenticateAndGetOptions(false);
  await Promise.all(exDates.map(async function(exDate) {
    let instances = [];
    instances = await fetchInstancesWithOriginalStart(token,
      calendarId, event.id, exDate);
    if (instances.length === 0 && event.start.hasOwnProperty(
        'dateTime')) {
      // If the event is not an all-day event and we get no exact match
      // for the exDate, we check whether there is a single instance on
      // the day described by exDate (with respect to exDate's time zone).
      // If there is a single instance on this day, we assume that the
      // exDate's time is off and this instance should be cancelled. This
      // appears to be Outlook's standard behavior.
      let startDay = exDate.clone();
      startDay.adjust(/* d */0, -exDate.hour, -exDate.minute, -exDate.second);
      let endDay = startDay.clone();
      endDay.adjust(1, 0, 0, 0);
      instances = await fetchInstancesWithinBounds(token, calendarId, event,
        startDay, endDay);
      // If we still get zero matches or match more than one event, we give up
      // and silently ignore this exDate.
      if (instances.length !== 1) {
        return;
      }
    }
    // The iCalendar specification says that duplicate instances must not be
    // generated, so strictly speaking this .all should not be necessary.
    await Promise.all(instances.map(instance => cancelInstance(
      token,
      calendarId,
      instance
    )));
  }));
}

function getRecurrenceRules(event) {
  // Rebind to the top-level component of the event
  let component = event.component;
  // Note: EXRULE has been deprecated and can lead to ambiguous results, so we
  // don't support it. EXDATE is treated specially. If RDATE is present, the
  // resulting recurrent event in the Google Calendar will be broken in the
  // sense that the instances can't be edited all at once (they can still be
  // deleted together).
  let recurrenceRuleStrings = [];
  for (let recurrenceProperty of ['rrule', 'rdate']) {
    for (let i = 0; i < component.getAllProperties(recurrenceProperty).length; i++) {
      let ruleString = component.getAllProperties(recurrenceProperty)[i].toICALString();
      recurrenceRuleStrings.push(ruleString);
    }
  }
  return recurrenceRuleStrings;
}

function uuidv4() {
  const randomBytes = new Uint8Array(16);
  window.crypto.getRandomValues(randomBytes);
  // Version: 4
  randomBytes[6] = 0x40 | (randomBytes[6] & 0x0F);
  // Variant: 1
  randomBytes[8] = 0x80 | (randomBytes[8] & 0x3F);
  let pos = 0;
  return 'xxxx-xx-xx-xx-xxxxxx'.replace(/x/g,
    () => randomBytes[pos++].toString(16).padStart(2, '0')
  );
}

function toGcalEvent(event) {
  // guess current timezone and use it for the ical event
  const tz = moment.tz.guess();
  // TODO(danny): actually convert between Outlook timezones and IANA timezones
  // but it's really wack, it looks like Outlook defines the entire timezone
  // in every file. WHY?
  const timeZoneStart = event.startDate.zone.toString();
  const timeZoneEnd = event.endDate.zone.toString();
  let gcalEvent = {
    'iCalUID': event.uid || uuidv4(),
    'start': {
      'dateTime': event.startDate.toString(),
      'timeZone': tz
    },
    'end': {
      'dateTime': event.endDate.toString(),
      'timeZone': tz
    },
    'description': '',
    'reminders': {
      'useDefault': true
    }
  };
  let exDates = [];
  if (event.isRecurring()) {
    gcalEvent.recurrence = getRecurrenceRules(event);
    const expanded = new ICAL.RecurExpansion({
      component: event.component,
      dtstart: event.component.getFirstPropertyValue('dtstart'),
    });
    exDates = expanded.exDates;
  }
  if (event.summary)
    gcalEvent.summary = event.summary;
  if (event.location)
    gcalEvent.location = event.location;
  if (event.description)
    gcalEvent.description = event.description;
  let url = event.component.getFirstPropertyValue('url');
  if (url)
    if (gcalEvent.description)
      gcalEvent.description += `\n\n${url}`;
    else
      gcalEvent.description += url;
  return [gcalEvent, exDates];
}

async function importEvent(gcalEvent, token, calendarId) {
  let response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/import`, {
        method: "POST",
        headers: new Headers({
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        }),
        body: JSON.stringify(gcalEvent)
      }).then(handleStatus);
  return response.json();
}

const addIcalToCalendar = async (url, token, calendarId) => {
  let icalText = "";
  try {
    const response = await fetch(url).then(handleStatus);
    icalText = await response.text();
  } catch (error) {
    console.warn(error);
    return;
  }

  let gcalEventsAndExDates = [];
  try {
    gcalEventsAndExDates = parseIcs(icalText).map(event => toGcalEvent(event));
  } catch (error) {
    console.warn("The iCal file has an invalid format.");
    return;
  }

  if (!gcalEventsAndExDates.length) {
    console.warn("Empty iCal file!");
    return;
  }
  console.log(`importing ${gcalEventsAndExDates.length} events`);

  let eventResponses = [];
  try {
    eventResponses = await Promise.all(gcalEventsAndExDates.map(
      async function(gcalEventAndExDates) {
        let [gcalEvent, exDates] = gcalEventAndExDates;
        let event = await importEvent(gcalEvent, token, calendarId);
        await cancelExDates(calendarId, event, exDates);
        return event;
      }));
  } catch (error) {
    if (gcalEventsAndExDates.length === 1) {
      console.log("Can't create the event.");
    } else {
      console.log("Can't create the events.");
    }
    console.log(error);
    return;
  }

  console.log(eventResponses);
}

const handleCardClick = async url => {
  let {token, calendarId} = await authenticateAndGetOptions(false);
  addIcalToCalendar(url, token, calendarId);
  
  console.log("Loading storage options");
}

InboxSDK.load(2, 'sdk_INBOX_2_GCAL_c33b848e16').then(function(sdk){
  sdk.Conversations.registerFileAttachmentCardViewHandler((fileAttachmentCard) => {
    if (fileAttachmentCard.getAttachmentType() !== "FILE") {
      return;
    }

    fileAttachmentCard.addButton({
      iconUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      tooltip: "Add to Calendar",
      onClick: (attachmentCardClickEvent) => {
        attachmentCardClickEvent.getDownloadURL().then(handleCardClick);
      }
    });
  });
  
});