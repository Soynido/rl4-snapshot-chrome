/**
 * RL4 Snapshot Extension - Background Service Worker
 * Handles extension lifecycle and optional message routing
 */

// Listen for extension installation
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[RL4] Extension installed', details.reason);
  
  if (details.reason === 'install') {
    console.log('[RL4] First installation - ready to capture Claude conversations');
  } else if (details.reason === 'update') {
    console.log('[RL4] Extension updated');
  }
});

// Optional: Handle messages from content script or popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'log') {
    console.log('[RL4 Background]', request.message);
    sendResponse({ success: true });
  }
  
  // Return true to indicate we will send a response asynchronously
  return true;
});

