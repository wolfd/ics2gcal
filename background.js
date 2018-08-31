async function authenticate(interactive) {
  return new Promise((resolve, reject) => {
    try {
      chrome.identity.getAuthToken({interactive}, (identity) => {
        resolve(identity);
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function getOptions() {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.get({
      calendarId: null,
    }, function(items) {
      resolve(items.calendarId);
    });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  Promise.all([getOptions(), authenticate(msg)]).then(([calendarId, token]) => {
    sendResponse({calendarId, token});
  });

  return true;
});
