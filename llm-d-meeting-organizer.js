/**
 * LLM-D Meeting File Organizer - Google Apps Script Version
 * 
 * This script automatically:
 * 1. Finds meeting recording subfolders (e.g., "[PUBLIC] llm-d sig-* (recurring)")
 *    inside the source "Google Meet" folder that match configured meeting patterns
 * 2. Moves the files inside those subfolders to organized folders in Google Drive
 * 3. Sends Slack notifications via webhooks
 * 4. Runs automatically every 15 minutes
 */

// CONFIGURATION is loaded from config.js file
// This keeps sensitive data (webhooks, folder IDs) out of the main script
// Note: In Google Apps Script, upload both this file and config.js

/**
 * @OnlyCurrentDoc
 * @oauthScopes https://www.googleapis.com/auth/drive
 */

/**
 * Main function that organizes meeting files
 * This gets called by the time-based trigger
 */
function organizeMeetingFiles() {
  try {
    if (CONFIG.DEBUG_MODE) {
      console.log('🐛 DEBUG MODE ENABLED - No files will be moved, operations will be logged only');
    }
    console.log('Starting meeting file organization...');
    
    // Find all meeting files in source folder
    const files = findMeetingFiles();
    console.log(`Found ${files.length} meeting files`);
    
    if (CONFIG.DEBUG_MODE) {
      console.log(`🐛 DEBUG: Source folder ID: ${CONFIG.SOURCE_FOLDER_ID}`);
      files.forEach((file, index) => {
        console.log(`🐛 DEBUG: [${index + 1}/${files.length}] Found file: ${file.title} (folder: "${file.meetingPrefix}")`);
      });
    }
    
    if (files.length === 0) {
      console.log('No files to process');
      if (CONFIG.DEBUG_MODE) {
        console.log(`🐛 DEBUG: No files found matching any configured meeting prefixes`);
      }
      return;
    }
    
    // Group files by meeting configuration
    const groupedFiles = groupFilesByMeetingConfig(files);
    
    if (CONFIG.DEBUG_MODE) {
      console.log(`🐛 DEBUG: Grouped files into ${Object.keys(groupedFiles).length} meeting configurations`);
      for (const [configKey, groupData] of Object.entries(groupedFiles)) {
        console.log(`🐛 DEBUG: - "${configKey}": ${groupData.files.length} files`);
      }
    }
    
    // Process each meeting group
    for (const [configKey, groupData] of Object.entries(groupedFiles)) {
      const { config, files: groupFiles, isChat } = groupData;
      console.log(`Processing ${groupFiles.length} files for "${configKey}"`);
      
      // Get target folder (create subfolder if needed)
      const targetFolder = getTargetFolder(config);
      
      let filesToNotify = groupFiles;
      
      // Move files to the folder (or log in debug mode)
      if (CONFIG.DEBUG_MODE) {
        logFileMoveOperations(groupFiles, targetFolder, configKey);
      } else {
        moveFilesToFolder(groupFiles, targetFolder);
        // After moving, get updated file links for the notification
        filesToNotify = groupFiles.map(fileData => {
          const file = DriveApp.getFileById(fileData.id);
          return {
            ...fileData,
            webViewLink: file.getUrl()
          };
        });
      }
      
      // Send Slack notification only for non-Chat files
      if (!isChat) {
        if (CONFIG.DEBUG_MODE) {
          sendDebugSlackNotification(configKey, config, filesToNotify);
        } else {
          sendConfiguredSlackNotification(configKey, config, filesToNotify);
        }
      } else {
        console.log(`Skipping Slack notification for Chat files: "${configKey}"`);
      }
      
      console.log(`Completed processing for "${configKey}"`);
    }
    
    console.log('Meeting file organization completed successfully');
  } catch (error) {
    console.error('Error organizing meeting files:', error);
    
    // Send error notification to monitoring channel
    sendErrorNotification(`Main script error: ${error.toString()}`)
    
    throw error;
  }
}

/**
 * Find all files in the source folder that match configured meeting patterns
 *
 * Google Drive now organizes Google Meet recordings into per-meeting-series
 * subfolders (e.g. "Google Meet" -> "[PUBLIC] llm-d Community Meeting (recurring)")
 * instead of dropping files flat into a single "meet recordings" folder. Each
 * subfolder's name is matched against the configured meeting prefixes, and every
 * file found directly inside a matching subfolder is tagged with that folder's
 * meeting configuration.
 */
function findMeetingFiles() {
  const files = [];
  const sourceFolder = DriveApp.getFolderById(CONFIG.SOURCE_FOLDER_ID);
  const subFolders = sourceFolder.getFolders();
  
  while (subFolders.hasNext()) {
    const subFolder = subFolders.next();
    const folderName = subFolder.getName();
    
    // Check if the subfolder name matches any configured meeting prefix
    const matchingConfig = findMatchingConfig(folderName);
    if (!matchingConfig) {
      if (CONFIG.DEBUG_MODE) {
        console.log(`🐛 DEBUG: Skipping folder "${folderName}" - no matching meeting configuration`);
      }
      continue;
    }
    
    const { prefix, config } = matchingConfig;
    const folderFiles = subFolder.getFiles();
    
    while (folderFiles.hasNext()) {
      const file = folderFiles.next();
      const fileName = file.getName();
      files.push({
        id: file.getId(),
        title: fileName,
        webViewLink: file.getUrl(),
        mimeType: file.getBlob().getContentType(),
        meetingPrefix: prefix,
        meetingConfig: config,
        isChat: fileName.includes('Chat')
      });
    }
  }
  
  return files;
}


/**
 * Find matching configuration for a title (used for both subfolder names and
 * individual file names, since matching is a simple substring check)
 */
function findMatchingConfig(title) {
  for (const [prefix, config] of Object.entries(CONFIG.MEETING_CONFIGS)) {
    if (title.includes(prefix)) {
      return { prefix, config, isChat: title.includes('Chat') };
    }
  }
  return null;
}

/**
 * Group files by their meeting configuration, handling Chat files separately
 *
 * Each file already carries the meeting prefix/config it was tagged with in
 * findMeetingFiles(), derived from the subfolder it was found in.
 */
function groupFilesByMeetingConfig(files) {
  const grouped = {};
  const chatFiles = {};
  
  files.forEach(file => {
    const { meetingPrefix: prefix, meetingConfig: config, isChat } = file;
    
    if (isChat) {
      // Handle Chat files separately - they don't need pairs
      if (!chatFiles[prefix]) {
        chatFiles[prefix] = {
          config,
          files: [],
          isChat: true
        };
      }
      chatFiles[prefix].files.push(file);
    } else {
      // Handle regular files that need pairs
      if (!grouped[prefix]) {
        grouped[prefix] = {
          config,
          files: []
        };
      }
      grouped[prefix].files.push(file);
    }
  });
  
  // Filter out groups that don't have both "Notes by Gemini" and "Recording" files
  const completeGroups = {};
  for (const [prefix, groupData] of Object.entries(grouped)) {
    const hasNotes = groupData.files.some(file => file.title.includes('Notes by Gemini'));
    const hasRecording = groupData.files.some(file => file.title.includes('Recording'));
    
    if (hasNotes && hasRecording) {
      completeGroups[prefix] = groupData;
      console.log(`Complete pair found for "${prefix}": ${groupData.files.length} files`);
    } else {
      console.log(`Incomplete pair for "${prefix}" - Notes: ${hasNotes}, Recording: ${hasRecording} - skipping until both are available`);
    }
  }
  
  // Add all Chat files to complete groups (they don't need pairs)
  for (const [prefix, chatData] of Object.entries(chatFiles)) {
    console.log(`Chat files found for "${prefix}": ${chatData.files.length} files`);
    completeGroups[prefix + '_chat'] = chatData;
  }
  
  return completeGroups;
}

/**
 * Get target folder from exact folder ID
 */
function getTargetFolder(config) {
  return DriveApp.getFolderById(config.targetFolderId);
}


/**
 * Log file move operations without actually moving files (debug mode)
 */
function logFileMoveOperations(files, folder, configKey) {
  console.log(`🐛 DEBUG: Would move ${files.length} files for "${configKey}"`);
  console.log(`🐛 DEBUG: Target folder ID: ${folder.getId()}`);
  
  files.forEach((fileData, index) => {
    console.log(`🐛 DEBUG: [${index + 1}/${files.length}] Would move file: ${fileData.title}`);
    console.log(`🐛 DEBUG:   - File ID: ${fileData.id}`);
  });
}

/**
 * Move files to the specified folder
 */
function moveFilesToFolder(files, folder) {
  files.forEach(fileData => {
    try {
      const file = DriveApp.getFileById(fileData.id);
      
      // Remove from all current parents
      const parents = file.getParents();
      while (parents.hasNext()) {
        const parent = parents.next();
        parent.removeFile(file);
      }
      
      // Add to new folder
      folder.addFile(file);
      
      console.log(`Moved file: ${fileData.title}`);
    } catch (error) {
      console.error(`Failed to move file ${fileData.title}:`, error);
    }
  });
}

/**
 * Send debug Slack notification to DEFAULT_WEBHOOK (your private channel)
 */
function sendDebugSlackNotification(configKey, config, files) {
  console.log(`🐛 DEBUG: Would send notification to ${config.slackChannel} via ${config.slackWebhook}`);
  console.log(`🐛 DEBUG: Instead sending test message to DEFAULT_WEBHOOK`);
  
  // Create the actual message that would be sent to the channel
  const fileLinks = files.map(file => 
    `• <${file.webViewLink}|${file.title}>`
  ).join('\n');
  
  const actualMessage = `Today's community meeting recording, transcript and AI summary are now available on the <https://drive.google.com/drive/folders/1cN2YQiAZFJD_cb1ivlyukuNwecnin6lZ|shared llm-d google drive>:\n${fileLinks}`;
  
  const payload = {
    text: `🐛 Debug mode test for ${config.slackChannel}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🐛 *Debug mode test* - This would be sent to ${config.slackChannel}:`
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: actualMessage
        }
      }
    ]
  };
  
  try {
    const response = UrlFetchApp.fetch(CONFIG.DEFAULT_WEBHOOK, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      payload: JSON.stringify(payload)
    });
    
    if (response.getResponseCode() === 200) {
      console.log(`🐛 DEBUG: Test notification sent to your private channel`);
    } else {
      console.error(`🐛 DEBUG: Failed to send test notification:`, response.getResponseCode());
    }
  } catch (error) {
    console.error(`🐛 DEBUG: Failed to send test notification:`, error);
  }
}

/**
 * Send Slack notification for organized files using new configuration
 */
function sendConfiguredSlackNotification(configKey, config, files) {
  const webhookUrl = config.slackWebhook;
  const channelName = config.slackChannel;
  
  if (!webhookUrl) {
    console.log(`No webhook configured for "${configKey}", skipping notification`);
    return;
  }
  
  const fileLinks = files.map(file => 
    `• <${file.webViewLink}|${file.title}>`
  ).join('\n');
  
  const payload = {
    text: `Today's community meeting recording, transcript and AI summary are now available on the shared llm-d google drive:`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Today's community meeting recording, transcript and AI summary are now available on the <https://drive.google.com/drive/folders/1cN2YQiAZFJD_cb1ivlyukuNwecnin6lZ|shared llm-d google drive>:\n${fileLinks}`
        }
      }
    ]
  };
  
  try {
    const response = UrlFetchApp.fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      payload: JSON.stringify(payload)
    });
    
    if (response.getResponseCode() === 200) {
      console.log(`Notification sent to ${channelName}`);
    } else {
      console.error(`Failed to send notification to ${channelName}:`, response.getResponseCode());
    }
  } catch (error) {
    console.error(`Failed to send notification to ${channelName}:`, error);
  }
}


/**
 * Send error notification to monitoring channel
 */
function sendErrorNotification(errorMessage) {
  if (!CONFIG.DEFAULT_WEBHOOK) {
    console.log('No DEFAULT_WEBHOOK configured, skipping error notification');
    return;
  }
  
  const payload = {
    text: `🚨 Error in LLM-D Meeting File Organizer`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🚨 *Error in LLM-D Meeting File Organizer*\n\`\`\`${errorMessage}\`\`\``
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Time:* ${new Date().toISOString()}`
        }
      }
    ]
  };
  
  try {
    UrlFetchApp.fetch(CONFIG.DEFAULT_WEBHOOK, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      payload: JSON.stringify(payload)
    });
    console.log('Error notification sent to DEFAULT_WEBHOOK');
  } catch (e) {
    console.error('Failed to send error notification:', e);
  }
}





/**
 * Setup function - run this once to create the time-based trigger
 * This replaces Firebase Cloud Scheduler
 */
function setupAutomaticTrigger() {
  // Delete any existing triggers for this function
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === 'organizeMeetingFiles') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  
  // Create new trigger to run every 15 minutes
  ScriptApp.newTrigger('organizeMeetingFiles')
    .timeBased()
    .everyMinutes(15)
    .create();
  
  console.log('Automatic trigger created - function will run every 15 minutes');
}

/**
 * Debug test function - run this to test in debug mode
 */
function testDebugMode() {
  const originalDebugMode = CONFIG.DEBUG_MODE;
  CONFIG.DEBUG_MODE = true;
  
  console.log('🐛 Starting DEBUG MODE test...');
  try {
    organizeMeetingFiles();
    console.log('🐛 DEBUG MODE test completed successfully');
  } catch (error) {
    console.error('🐛 DEBUG MODE test failed:', error);
  } finally {
    CONFIG.DEBUG_MODE = originalDebugMode;
  }
}

/**
 * Manual test function - run this to test the file organization
 */
function testFileOrganization() {
  console.log('Running manual test...');
  organizeMeetingFiles();
  console.log('Manual test completed');
}

/**
 * Function to list current project triggers
 */
function listTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  console.log(`Found ${triggers.length} triggers:`);
  
  triggers.forEach((trigger, index) => {
    console.log(`${index + 1}. Function: ${trigger.getHandlerFunction()}`);
    console.log(`   Type: ${trigger.getTriggerSource()}`);
    if (trigger.getTriggerSource() === ScriptApp.TriggerSource.CLOCK) {
      console.log(`   Schedule: Every ${trigger.getTimeBased().getInterval()} minutes`);
    }
  });
}

