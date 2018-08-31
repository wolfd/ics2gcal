function handleStatus(response) {
  if (response.status >= 200 && response.status < 300) {
    return Promise.resolve(response);
  } else {
    return Promise.reject(new Error(response.statusText));
  }
}

async function authenticate(interactive) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(
        undefined,
        interactive,
        undefined,
        response => {
          resolve(response.token);
        }
      );
    } catch (error) {
      reject(error);
    }
  });
}

async function fetchCalendars(interactive) {
  let calendars = [];
  let hiddenCalendars = [];

  let token = await authenticate(interactive);
  let responseCalendarList = null;
  try {
    let response = await fetch(
        `https://www.googleapis.com/calendar/v3/users/me/calendarList?access_token=${token}`, {
          method: "GET"
        })
      .then(handleStatus);
    responseCalendarList = await response.json();
  } catch (error) {
    console.log("Failed to fetch calendars.");
    console.log(error);
    return {
      calendars,
      hiddenCalendars
    };
  }
  
  for (let item of responseCalendarList.items) {
    // Only consider calendars in which we can create events
    if (item.accessRole !== 'owner' && item.accessRole !== 'writer') {
      continue;
    }
    if (item.selected) {
      calendars.push([item.id, item.summary]);
    }
    else {
      hiddenCalendars.push([item.id, item.summary]);
    }
  }

  return {
    calendars,
    hiddenCalendars
  };
}

// Saves options to chrome.storage
function saveOptions() {
  var calendarId = document.getElementById('calendar').value;
  chrome.storage.sync.set({
    calendarId,
  }, function() {
    // Update status to let user know options were saved.
    var status = document.getElementById('status');
    status.textContent = 'Options saved.';
    setTimeout(function() {
      status.textContent = '';
    }, 750);
  });
}

// Restores select box and checkbox state using the preferences
// stored in chrome.storage.
async function restoreOptions() {
  const calendarElem = document.getElementById('calendar');
  const {calendars, hiddenCalendars} = await fetchCalendars(true);
  calendars.map(calendarInfo => {
    const [id, name] = calendarInfo;
    const newOption = document.createElement("option");
    newOption.value = id;
    newOption.text = name;
    calendarElem.appendChild(newOption);
  });
  // Use default values
  chrome.storage.sync.get({
    calendarId: null,
  }, function(items) {
    calendarElem.value = items.calendarId;
  });
}
document.addEventListener('DOMContentLoaded', restoreOptions);
document.getElementById('save').addEventListener('click', saveOptions);
