/**
 * Background Service Worker (Manifest V3)
 *
 * Responsibilities:
 * 1. Handle messages from content script and extension app
 * 2. Inject overlay on Discord tabs
 * 3. Forward token requests between content script and app
 * 4. Handle streaming downloads via setupStreamingDownloads()
 *
 * The background acts as the service worker controller for all extension pages,
 * enabling streaming downloads for both Discrub 2.0 and Discrub Classic.
 */

import { setupStreamingDownloads } from 'drip-fs/background';

setupStreamingDownloads();

console.log('[Discrub Background] Background script initialized');

/**
 * Message handler
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Discrub Background] Received message:', message.action);

  // Extension app → show a scheduled export notification
  if (message.action === 'showNotification') {
    showScheduleNotification(String(message.title ?? 'Discrub'), String(message.message ?? ''), sender);
    sendResponse({ success: true });
    return;
  }

  // Extension app → request token from content script
  if (message.action === 'requestToken') {
    // Find discord.com tab
    chrome.tabs.query(
      { url: ['*://discord.com/*', '*://*.discord.com/*'] },
      (tabs) => {
        if (tabs.length === 0) {
          console.warn('[Discrub Background] No Discord tabs found');
          sendResponse({
            success: false,
            error: 'No Discord tabs open. Open discord.com first.'
          });
          return;
        }

        // Send message to content script on discord.com
        const discordTab = tabs[0];
        chrome.tabs.sendMessage(
          discordTab.id!,
          { action: 'getToken' },
          (response) => {
            if (chrome.runtime.lastError) {
              console.error('[Discrub Background] Content script not responding:', chrome.runtime.lastError);
              sendResponse({
                success: false,
                error: 'Failed to communicate with Discord tab. Try refreshing discord.com.'
              });
            } else {
              console.log('[Discrub Background] Token response:', response?.success ? 'Success' : 'Failed');
              sendResponse(response);
            }
          }
        );
      }
    );

    return true; // Keep channel open for async response
  }

  // Extension app → inject overlay on Discord
  if (message.action === 'injectOverlay') {
    console.log('[Discrub Background] Injecting overlay on Discord tab');

    // Find active Discord tab first, fall back to any Discord tab
    chrome.tabs.query(
      { url: ['*://discord.com/*', '*://*.discord.com/*'], active: true, currentWindow: true },
      (activeTabs) => {
        if (activeTabs.length > 0) {
          // Use active tab
          sendInjectMessage(activeTabs[0]);
        } else {
          // Fall back to any Discord tab
          chrome.tabs.query(
            { url: ['*://discord.com/*', '*://*.discord.com/*'] },
            (allTabs) => {
              if (allTabs.length === 0) {
                console.warn('[Discrub Background] No Discord tabs found');
                sendResponse({
                  success: false,
                  error: 'No Discord tabs open. Open discord.com first.'
                });
                return;
              }
              sendInjectMessage(allTabs[0]);
            }
          );
        }
      }
    );

    function sendInjectMessage(tab: chrome.tabs.Tab) {
      chrome.tabs.sendMessage(
        tab.id!,
        { action: 'injectOverlay' },
        (response) => {
          if (chrome.runtime.lastError) {
            console.error('[Discrub Background] Content script not responding:', chrome.runtime.lastError);
            sendResponse({
              success: false,
              error: 'Failed to communicate with Discord tab. Try refreshing discord.com.'
            });
          } else {
            console.log('[Discrub Background] Overlay injection:', response?.success ? 'Success' : 'Failed');
            sendResponse(response);
          }
        }
      );
    }

    return true; // Keep channel open for async response
  }

  // Extension app → close overlay on Discord
  if (message.action === 'closeOverlay') {
    console.log('[Discrub Background] Closing overlay on Discord tab');

    chrome.tabs.query(
      { url: ['*://discord.com/*', '*://*.discord.com/*'] },
      (tabs) => {
        if (tabs.length === 0) {
          console.warn('[Discrub Background] No Discord tabs found');
          sendResponse({
            success: false,
            error: 'No Discord tabs open.'
          });
          return;
        }

        // Send close message to content script
        const discordTab = tabs[0];
        chrome.tabs.sendMessage(
          discordTab.id!,
          { action: 'closeOverlay' },
          (response) => {
            if (chrome.runtime.lastError) {
              console.error('[Discrub Background] Content script not responding:', chrome.runtime.lastError);
              sendResponse({
                success: false,
                error: 'Failed to communicate with Discord tab.'
              });
            } else {
              console.log('[Discrub Background] Overlay closed');
              sendResponse(response);
            }
          }
        );
      }
    );

    return true; // Keep channel open for async response
  }

  // Extension app → minimize overlay on Discord
  if (message.action === 'minimizeOverlay') {
    console.log('[Discrub Background] Minimizing overlay on Discord tab');

    chrome.tabs.query(
      { url: ['*://discord.com/*', '*://*.discord.com/*'] },
      (tabs) => {
        if (tabs.length === 0) {
          sendResponse({ success: false, error: 'No Discord tabs open.' });
          return;
        }

        const discordTab = tabs[0];
        chrome.tabs.sendMessage(
          discordTab.id!,
          { action: 'minimizeOverlay' },
          (response) => {
            if (chrome.runtime.lastError) {
              console.error('[Discrub Background] Content script not responding:', chrome.runtime.lastError);
              sendResponse({ success: false, error: 'Failed to communicate with Discord tab.' });
            } else {
              sendResponse(response);
            }
          }
        );
      }
    );

    return true; // Keep channel open for async response
  }

  // Extension app → restore overlay on Discord
  if (message.action === 'restoreOverlay') {
    console.log('[Discrub Background] Restoring overlay on Discord tab');

    chrome.tabs.query(
      { url: ['*://discord.com/*', '*://*.discord.com/*'] },
      (tabs) => {
        if (tabs.length === 0) {
          sendResponse({ success: false, error: 'No Discord tabs open.' });
          return;
        }

        const discordTab = tabs[0];
        chrome.tabs.sendMessage(
          discordTab.id!,
          { action: 'restoreOverlay' },
          (response) => {
            if (chrome.runtime.lastError) {
              console.error('[Discrub Background] Content script not responding:', chrome.runtime.lastError);
              sendResponse({ success: false, error: 'Failed to communicate with Discord tab.' });
            } else {
              sendResponse(response);
            }
          }
        );
      }
    );

    return true; // Keep channel open for async response
  }

  // Handle Discrub Classic messages (different format: {message: "..."} instead of {action: "..."})
  if (message.message === 'CLOSE_INJECTED_DIALOG') {
    console.log('[Discrub Background] Classic requested close');

    chrome.tabs.query(
      { url: ['*://discord.com/*', '*://*.discord.com/*'] },
      (tabs) => {
        if (tabs.length > 0) {
          chrome.tabs.sendMessage(
            tabs[0].id!,
            { action: 'closeOverlay' },
            (response) => {
              if (chrome.runtime.lastError) {
                console.error('[Discrub Background] Failed to close overlay:', chrome.runtime.lastError);
              }
              sendResponse(response || { success: true });
            }
          );
        }
      }
    );

    return true;
  }

  return false;
});

/**
 * Extension icon click handler - inject overlay on active Discord tab
 */
const openExtensionOverlay = () => {
  console.log('[Discrub Background] Extension icon clicked');

  // Try to inject overlay on active Discord tab
  chrome.tabs.query(
    { url: ['*://discord.com/*', '*://*.discord.com/*'], active: true, currentWindow: true },
    (activeTabs) => {
      if (activeTabs.length > 0) {
        // Active Discord tab found - inject overlay
        chrome.tabs.sendMessage(
          activeTabs[0].id!,
          { action: 'injectOverlay' },
          (_response) => {
            if (chrome.runtime.lastError) {
              console.warn('[Discrub Background] Could not inject overlay:', chrome.runtime.lastError.message);
            }
          }
        );
      } else {
        // No active Discord tab - check for any Discord tab
        chrome.tabs.query(
          { url: ['*://discord.com/*', '*://*.discord.com/*'] },
          (allTabs) => {
            if (allTabs.length > 0) {
              // Discord tab exists but not active - switch to it and inject
              chrome.tabs.update(allTabs[0].id!, { active: true }, () => {
                chrome.tabs.sendMessage(
                  allTabs[0].id!,
                  { action: 'injectOverlay' },
                  (_response) => {
                    if (chrome.runtime.lastError) {
                      console.warn('[Discrub Background] Could not inject overlay:', chrome.runtime.lastError.message);
                    }
                  }
                );
              });
            } else {
              console.warn('[Discrub Background] No Discord tabs found. Open discord.com first.');
            }
          }
        );
      }
    }
  );
};

chrome.action.onClicked.addListener(openExtensionOverlay);

/**
 * Scheduled export notifications. The app runs in a frame inside the Discord
 * tab, where browsers do not allow web notifications, so it asks here.
 * Clicking one brings that Discord tab to the front.
 */
const notificationTabs = new Map<string, { tabId: number; windowId?: number }>();
let notificationSeq = 0;

function showScheduleNotification(title: string, message: string, sender: chrome.runtime.MessageSender): void {
  if (!chrome.notifications?.create) return;
  notificationSeq += 1;
  const id = `discrub-schedule-${Date.now()}-${notificationSeq}`;
  chrome.notifications.create(
    id,
    { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon-128.png'), title, message },
    (createdId) => {
      if (sender.tab?.id !== undefined) {
        notificationTabs.set(createdId, { tabId: sender.tab.id, windowId: sender.tab.windowId });
      }
    },
  );
}

chrome.notifications?.onClicked?.addListener((id) => {
  const target = notificationTabs.get(id);
  notificationTabs.delete(id);
  chrome.notifications.clear(id);
  if (!target) return;
  chrome.tabs.update(target.tabId, { active: true });
  if (target.windowId !== undefined) chrome.windows?.update?.(target.windowId, { focused: true });
});

chrome.notifications?.onClosed?.addListener((id) => {
  notificationTabs.delete(id);
});

/**
 * Extension lifecycle events
 */
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[Discrub Background] Extension installed');
  } else if (details.reason === 'update') {
    console.log('[Discrub Background] Extension updated to version', chrome.runtime.getManifest().version);
  }
});

/**
 * Content scripts hold a port open so they notice an extension update or
 * reload and take their dead overlay off the page (#251). Nothing travels
 * over it; accepting the connection is enough.
 */
chrome.runtime.onConnect?.addListener(() => {});

// Module export to allow dynamic import in tests
export {};
