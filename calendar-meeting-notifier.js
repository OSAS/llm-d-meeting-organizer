/**
 * LLM-D Calendar Meeting Notifier
 * 
 * Automatically checks a shared Google Calendar every minute and posts Slack notifications 
 * for meetings that are starting RIGHT NOW.
 * 
 * Features:
 * - Runs every minute for precise timing
 * - Notifies only when meetings are actually starting (1min early to 15sec late window)
 * - Sends only ONE notification per meeting (prevents duplicate alerts)
 * - Posts to specific SIG channels + #community (except Community Meeting which only goes to #community)
 * - Includes Google Meet links in visually appealing format
 * - Automatic cleanup of old notification records
 * - Debug mode for testing message formatting
 * 
 * Timing Logic:
 * - Searches for meetings starting within 1 minute early to 15 seconds late of current time
 * - Prevents early notifications while accounting for trigger timing variations
 * - Notifications sent AT meeting start time, with minimal early notification window
 * 
 * Storage Management:
 * - Uses PropertiesService to track which meetings have been notified
 * - Smart cleanup strategy adapts to current storage usage
 * - Daily end-of-day cleanup (11:30 PM) removes records older than 6 hours
 * - Emergency cleanup prevents hitting 50-property limit
 * - Storage monitoring and health alerts
 * - Prevents duplicate notifications when script runs every minute
 * 
 * Setup Instructions: See CALENDAR_MEETING_NOTIFIER.md
 */

// Load configuration - create config.js based on config.example.js
// This will be loaded automatically when the script runs

/**
 * Main function to check calendar and send notifications
 * Called by the scheduled trigger every minute
 */
function checkCalendarAndNotify() {
  try {
    console.log('🕐 Starting calendar check at:', new Date().toISOString());
    
    // Clean up old notification records periodically (every 10 minutes)
    const currentMinute = new Date().getMinutes();
    if (currentMinute % 10 === 0) {
      console.log('🧹 Running cleanup of old notification records...');
      cleanupOldNotificationRecords();
    }
    
    // Configuration should be loaded from config.js in this script
    
    // Get meetings starting RIGHT NOW (within tighter notification window)
    const meetingsStartingNow = getUpcomingMeetings(CONFIG);
    
    if (meetingsStartingNow.length === 0) {
      console.log('📅 No meetings starting now');
      return;
    }
    
    console.log(`📅 Found ${meetingsStartingNow.length} meeting(s) starting NOW`);
    
    // Process each meeting
    for (const meeting of meetingsStartingNow) {
      processMeeting(meeting, CONFIG);
    }
    
  } catch (error) {
    console.error('❌ Error in checkCalendarAndNotify:', error);
    sendErrorNotification('Calendar check failed', error.toString());
  }
}

/**
 * Get meetings starting RIGHT NOW (within tighter 1min early to 15sec late window)
 */
function getUpcomingMeetings() {
  try {
    const now = new Date();
    
    // Look for meetings starting within the next 3 minutes (broader search to find candidates)
    const searchStart = new Date(now.getTime() - (90 * 1000)); // 90 seconds ago
    const searchEnd = new Date(now.getTime() + (3 * 60 * 1000)); // 3 minutes from now
    
    console.log(`🕐 Current time: ${now.toLocaleTimeString()}`);
    console.log(`📅 Search window: ${searchStart.toLocaleTimeString()} - ${searchEnd.toLocaleTimeString()}`);
    
    // Get the calendar by ID (configured in CONFIG)
    const calendar = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
    
    if (!calendar) {
      throw new Error(`Calendar not found with ID: ${CONFIG.CALENDAR_ID}`);
    }
    
    // Get events in the search window
    const events = calendar.getEvents(searchStart, searchEnd);
    
    const meetingsStartingNow = [];
    
    for (const event of events) {
      const title = event.getTitle();
      const startTime = event.getStartTime();
      
      // Skip meetings with "Canceled" in the title (case-insensitive)
      if (title.toLowerCase().includes('canceled')) {
        console.log(`⏭️ Skipping canceled meeting: "${title}"`);
        continue;
      }
      
      // Calculate how many seconds until/since the meeting starts
      const timeUntilStart = startTime.getTime() - now.getTime();
      const secondsUntilStart = Math.floor(timeUntilStart / 1000);
      
      console.log(`📋 Checking meeting: "${title}"`);
      console.log(`🕐 Meeting starts: ${startTime.toLocaleTimeString()}`);
      console.log(`⏱️  Seconds until start: ${secondsUntilStart}`);
      
      // Only include meetings starting within 1 minute early to 15 seconds late (tighter window)
      // This prevents 2-minute early notifications while still allowing for trigger timing variations
      if (secondsUntilStart >= -60 && secondsUntilStart <= 15) {
        console.log(`✅ Meeting is starting NOW (within 1min early to 15sec late)`);
        
        // Check if this meeting matches any of our configured prefixes
        const matchedConfig = findMatchingMeetingConfig(title);
        
        if (matchedConfig) {
          // EARLY CACHE CHECK: Skip expensive processing if already notified
          if (hasAlreadyNotifiedEvent(event)) {
            console.log(`⏭️ Skipping - already notified for "${title}"`);
            continue;
          }
          
          // Only do expensive meeting details extraction if we haven't notified yet
          const meetingDetails = extractMeetingDetails(event);
          
          meetingsStartingNow.push({
            title: title,
            startTime: startTime,
            meetLink: meetingDetails.meetLink,
            documents: meetingDetails.documents,
            hasDocuments: meetingDetails.hasDocuments,
            config: matchedConfig,
            event: event
          });
          
          console.log(`📋 Added to notification queue: ${title}`);
        } else {
          console.log(`⏭️ Meeting starting now but no config match: ${title}`);
        }
      } else {
        console.log(`⏭️ Meeting not starting now (${secondsUntilStart}s away) - skipping`);
      }
    }
    
    if (meetingsStartingNow.length > 0) {
      console.log(`🎯 Found ${meetingsStartingNow.length} meeting(s) starting NOW`);
    } else {
      console.log(`📅 No meetings starting within notification window (1min early to 15sec late)`);
    }
    
    return meetingsStartingNow;
    
  } catch (error) {
    console.error('❌ Error getting meetings starting now:', error);
    throw error;
  }
}

/**
 * Extract file ID from Google Drive URL
 */
function extractFileIdFromUrl(url) {
  const patterns = [
    /\/file\/d\/([a-zA-Z0-9-_]+)/,
    /\/document\/d\/([a-zA-Z0-9-_]+)/,
    /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/,
    /\/presentation\/d\/([a-zA-Z0-9-_]+)/,
    /[?&]id=([a-zA-Z0-9-_]+)/,
    /\/open\?id=([a-zA-Z0-9-_]+)/
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      console.log(`✅ Extracted file ID ${match[1]} from URL using pattern: ${pattern}`);
      return match[1];
    }
  }
  console.log(`❌ Could not extract file ID from URL: ${url}`);
  return null;
}

/**
 * Get file name from Google Drive using the Drive API
 */
function getFileNameFromDrive(fileId) {
  try {
    const file = DriveApp.getFileById(fileId);
    return file.getName();
  } catch (error) {
    console.log(`ℹ️ Could not get file name for ID ${fileId}:`, error.message);
    return null;
  }
}

/**
 * Try to use the advanced Calendar API to get more event details
 */
function getAdvancedEventDetails(event) {
  try {
    // Try to use the advanced Calendar API if available
    const eventId = event.getId();
    const calendarId = CONFIG.CALENDAR_ID;
    
    console.log('🔍 Attempting advanced Calendar API access...');
    console.log('📋 Event ID:', eventId);
    console.log('📅 Calendar ID:', calendarId);
    
    // Try to access the Calendar API directly for more detailed information
    // This requires the Calendar API to be enabled
    const calendarService = Calendar.Events;
    if (calendarService) {
      const detailedEvent = calendarService.get(calendarId, eventId.split('@')[0]);
      
      console.log('✅ Advanced Calendar API access successful');
      console.log('🔍 Conference data:', detailedEvent.conferenceData ? 'Found' : 'None');
      console.log('🔍 Attachments:', detailedEvent.attachments ? detailedEvent.attachments.length : 0);
      console.log('🔍 Extended properties:', detailedEvent.extendedProperties ? 'Found' : 'None');
      
      return {
        conferenceData: detailedEvent.conferenceData,
        attachments: detailedEvent.attachments || [],
        extendedProperties: detailedEvent.extendedProperties,
        htmlLink: detailedEvent.htmlLink,
        description: detailedEvent.description
      };
    }
  } catch (apiError) {
    console.log('ℹ️ Advanced Calendar API not available or not enabled:', apiError.message);
    console.log('💡 You may need to enable the Calendar API in your Google Apps Script project');
  }
  
  return null;
}

/**
 * Extract Google Meet link and attached documents from calendar event
 */
function extractMeetingDetails(event) {
  try {
    const description = event.getDescription() || '';
    const location = event.getLocation() || '';
    
    // Debug: Show what we're working with
    console.log('🔍 Event debugging:');
    console.log('📝 Description length:', description.length);
    console.log('📍 Location:', location);
    console.log('📝 Description preview:', description.substring(0, 200) + (description.length > 200 ? '...' : ''));
    
    // Try advanced Calendar API first
    const advancedDetails = getAdvancedEventDetails(event);
    let meetLink = null;
    const driveLinks = [];
    
    if (advancedDetails) {
      // Extract Meet link from conference data
      if (advancedDetails.conferenceData && advancedDetails.conferenceData.entryPoints) {
        const meetEntry = advancedDetails.conferenceData.entryPoints.find(ep => 
          ep.entryPointType === 'video' && ep.uri && ep.uri.includes('meet.google.com')
        );
        if (meetEntry) {
          meetLink = meetEntry.uri;
          console.log('✅ Found Meet link from conference data:', meetLink);
        }
      }
      
      // Extract documents from attachments
      if (advancedDetails.attachments && advancedDetails.attachments.length > 0) {
        advancedDetails.attachments.forEach(attachment => {
          if (attachment.fileUrl) {
            driveLinks.push(attachment.fileUrl);
            console.log('✅ Found attachment:', attachment.fileUrl);
          }
        });
      }
      
      // Also check the HTML description for additional links
      if (advancedDetails.description && advancedDetails.description.length > description.length) {
        console.log('✅ Found richer description from API');
        const richDescription = advancedDetails.description;
        const richDriveRegex = /https:\/\/(?:docs|drive)\.google\.com\/[^\s\)\>\"]+/g;
        const richDriveLinks = richDescription.match(richDriveRegex) || [];
        richDriveLinks.forEach(link => {
          if (!driveLinks.includes(link)) {
            driveLinks.push(link);
            console.log('✅ Found additional Drive link from rich description:', link);
          }
        });
      }
    }
    
    // Fallback to basic description/location parsing if advanced API didn't work
    if (!meetLink) {
      console.log('🔍 Falling back to basic description/location parsing...');
      const meetRegex = /https:\/\/meet\.google\.com\/[a-z-]+/g;
      let meetMatch = description.match(meetRegex);
      if (!meetMatch) {
        meetMatch = location.match(meetRegex);
      }
      if (meetMatch) {
        meetLink = meetMatch[0];
        console.log('✅ Found Meet link in description/location:', meetLink);
      }
    }
    
    // Fallback document parsing if we didn't find any from attachments
    if (driveLinks.length === 0) {
      console.log('🔍 Falling back to basic document link parsing...');
      const driveRegex = /https:\/\/(?:docs|drive)\.google\.com\/[^\s\)\>]+/g;
      const basicDriveLinks = description.match(driveRegex) || [];
      driveLinks.push(...basicDriveLinks);
    }
    
    // Extract file names for each document
    const documentsWithNames = driveLinks.map((url, index) => {
      console.log(`🔍 Processing document ${index + 1}: ${url}`);
      const fileId = extractFileIdFromUrl(url);
      let fileName = null;
      let fileType = '📁';
      
      if (fileId) {
        console.log(`📎 Extracted file ID: ${fileId}`);
        fileName = getFileNameFromDrive(fileId);
        console.log(`📎 File name: ${fileName}`);
        
        // Determine file type icon based on URL
        if (url.includes('/document/')) {
          fileType = '📄';
        } else if (url.includes('/spreadsheets/')) {
          fileType = '📊';
        } else if (url.includes('/presentation/')) {
          fileType = '📑';
        }
      } else {
        console.log(`❌ Could not extract file ID from: ${url}`);
      }
      
      return {
        url: url,
        fileName: fileName,
        fileType: fileType,
        displayName: fileName || 'Google Drive File'
      };
    });
    
    console.log(`📊 Final results: Meet link: ${meetLink ? 'Found' : 'Not found'}, Documents: ${documentsWithNames.length}`);
    
    return {
      meetLink: meetLink,
      documents: documentsWithNames,
      hasDocuments: documentsWithNames.length > 0
    };
    
  } catch (error) {
    console.error('❌ Error extracting meeting details:', error);
    return {
      meetLink: null,
      documents: [],
      hasDocuments: false
    };
  }
}

/**
 * Find matching meeting configuration based on title prefix
 */
function findMatchingMeetingConfig(title) {
  for (const [prefix, config] of Object.entries(CONFIG.MEETING_CONFIGS)) {
    if (title.startsWith(prefix)) {
      return {
        prefix: prefix,
        ...config
      };
    }
  }
  return null;
}

/**
 * Get unique identifier for a meeting event to track notifications
 */
function getMeetingNotificationKey(meeting) {
  // Use event ID combined with start time to create unique key
  const eventId = meeting.event.getId();
  const startTimeKey = meeting.startTime.toISOString();
  return `notified_${eventId}_${startTimeKey}`;
}

/**
 * Get unique identifier for a meeting using basic event info (for early cache check)
 */
function getMeetingNotificationKeyFromEvent(event) {
  // Use event ID combined with start time to create unique key
  const eventId = event.getId();
  const startTimeKey = event.getStartTime().toISOString();
  return `notified_${eventId}_${startTimeKey}`;
}

/**
 * Check if we have already sent notifications for this event (early check without full processing)
 */
function hasAlreadyNotifiedEvent(event) {
  const key = getMeetingNotificationKeyFromEvent(event);
  const properties = PropertiesService.getScriptProperties();
  const notificationRecord = properties.getProperty(key);
  
  if (notificationRecord) {
    const recordData = JSON.parse(notificationRecord);
    console.log(`✅ Already notified for event "${event.getTitle()}" at ${recordData.notifiedAt}`);
    return true;
  }
  
  return false;
}

/**
 * Check if we have already sent notifications for this meeting
 */
function hasAlreadyNotified(meeting) {
  const key = getMeetingNotificationKey(meeting);
  const properties = PropertiesService.getScriptProperties();
  const notificationRecord = properties.getProperty(key);
  
  if (notificationRecord) {
    const recordData = JSON.parse(notificationRecord);
    console.log(`✅ Already notified for meeting "${meeting.title}" at ${recordData.notifiedAt}`);
    return true;
  }
  
  return false;
}

/**
 * Record that we have sent notifications for this meeting
 */
function recordNotificationSent(meeting) {
  // Skip saving notification records in debug mode to avoid blocking real notifications
  if (CONFIG.DEBUG_MODE) {
    console.log(`🧪 Debug mode - NOT recording notification for "${meeting.title}" (test only)`);
    return;
  }
  
  const key = getMeetingNotificationKey(meeting);
  const properties = PropertiesService.getScriptProperties();
  
  const recordData = {
    meetingTitle: meeting.title,
    meetingStart: meeting.startTime.toISOString(),
    notifiedAt: new Date().toISOString()
  };
  
  properties.setProperty(key, JSON.stringify(recordData));
  console.log(`📝 Recorded notification sent for meeting "${meeting.title}"`);
}

/**
 * Clean up old notification records with smart aging strategy
 * Prevents PropertiesService storage from hitting the 50 property limit
 */
function cleanupOldNotificationRecords() {
  try {
    const properties = PropertiesService.getScriptProperties();
    const allProperties = properties.getProperties();
    const now = new Date();
    
    // Count notification records to check against limits
    const notificationRecords = [];
    for (const [key, value] of Object.entries(allProperties)) {
      if (key.startsWith('notified_')) {
        try {
          const recordData = JSON.parse(value);
          notificationRecords.push({
            key: key,
            data: recordData,
            notifiedTime: new Date(recordData.notifiedAt)
          });
        } catch (parseError) {
          // Corrupted record - mark for deletion
          notificationRecords.push({
            key: key,
            data: null,
            notifiedTime: new Date(0) // Very old date to ensure deletion
          });
        }
      }
    }
    
    console.log(`📊 Current notification records: ${notificationRecords.length}/50 (PropertiesService limit)`);
    
    let cleanedCount = 0;
    
    // Strategy 1: Always remove corrupted records
    const corruptedRecords = notificationRecords.filter(record => !record.data);
    for (const record of corruptedRecords) {
      properties.deleteProperty(record.key);
      cleanedCount++;
      console.log(`🧹 Cleaned up corrupted notification record: ${record.key}`);
    }
    
    // Strategy 2: Aggressive cleanup based on current load
    let cutoffHours;
    if (notificationRecords.length >= 45) {
      // Near limit - very aggressive cleanup (4 hours)
      cutoffHours = 4;
      console.log('⚠️ Near PropertiesService limit - using aggressive 4-hour cleanup');
    } else if (notificationRecords.length >= 30) {
      // Getting full - moderate cleanup (8 hours) 
      cutoffHours = 8;
      console.log('📈 Storage getting full - using 8-hour cleanup');
    } else {
      // Normal cleanup (24 hours)
      cutoffHours = 24;
    }
    
    const cutoffTime = new Date(now.getTime() - (cutoffHours * 60 * 60 * 1000));
    
    // Strategy 3: Time-based cleanup
    for (const record of notificationRecords) {
      if (record.data && record.notifiedTime < cutoffTime) {
        properties.deleteProperty(record.key);
        cleanedCount++;
        console.log(`🧹 Cleaned up old notification record (${cutoffHours}h): ${record.data.meetingTitle}`);
      }
    }
    
    // Strategy 4: Emergency cleanup if still near limit
    const remainingRecords = notificationRecords.length - cleanedCount;
    if (remainingRecords >= 48) { // Leave room for new meetings
      console.log('🚨 EMERGENCY: Still near limit after cleanup - removing oldest records');
      
      // Sort by notification time and remove oldest
      const sortedRecords = notificationRecords
        .filter(record => record.data) // Only valid records
        .sort((a, b) => a.notifiedTime - b.notifiedTime);
      
      const recordsToRemove = remainingRecords - 40; // Keep it well under 50
      for (let i = 0; i < recordsToRemove && i < sortedRecords.length; i++) {
        const record = sortedRecords[i];
        properties.deleteProperty(record.key);
        cleanedCount++;
        console.log(`🚨 Emergency cleanup: ${record.data.meetingTitle}`);
      }
    }
    
    if (cleanedCount > 0) {
      console.log(`🧹 Cleaned up ${cleanedCount} notification record(s) using ${cutoffHours}h cutoff`);
      
      // Send alert if we had to use aggressive cleanup
      if (cutoffHours < 24) {
        const remainingAfterCleanup = notificationRecords.length - cleanedCount;
        sendDebugMessage(`⚠️ Used aggressive cleanup (${cutoffHours}h) - had ${notificationRecords.length} records, now ${remainingAfterCleanup}`);
      }
    } else {
      console.log(`✅ No cleanup needed - ${notificationRecords.length} records, ${cutoffHours}h cutoff`);
    }
    
  } catch (error) {
    console.error('❌ Error cleaning up notification records:', error);
  }
}

/**
 * Process a single meeting and send notifications
 */
function processMeeting(meeting) {
  try {
    console.log(`📋 Processing meeting: ${meeting.title}`);
    console.log(`🕐 Start time: ${meeting.startTime}`);
    
    // Check if we've already sent notifications for this meeting
    if (hasAlreadyNotified(meeting)) {
      console.log(`⏭️ Skipping notifications - already sent for "${meeting.title}"`);
      return;
    }
    
    // Determine which channels to notify
    const channelsToNotify = getChannelsToNotify(meeting.config);
    
    for (const channel of channelsToNotify) {
      // Format message based on target channel
      const message = formatSlackMessage(meeting, channel.name);
      sendSlackNotification(channel.webhook, message, channel.name);
    }
    
    // Record that we've sent notifications for this meeting
    recordNotificationSent(meeting);
    
  } catch (error) {
    console.error(`❌ Error processing meeting ${meeting.title}:`, error);
    sendErrorNotification(`Failed to process meeting: ${meeting.title}`, error.toString());
  }
}

/**
 * Determine which channels should receive notifications
 */
function getChannelsToNotify(meetingConfig) {
  const channels = [];
  
  // Community Meeting only goes to #community
  if (meetingConfig.prefix === '[PUBLIC] llm-d Community Meeting') {
    channels.push({
      webhook: meetingConfig.slackWebhook,
      name: meetingConfig.slackChannel
    });
  } else {
    // SIG meetings go to both their specific channel and #community
    channels.push({
      webhook: meetingConfig.slackWebhook,
      name: meetingConfig.slackChannel
    });
    
    // Also send to community channel (find community config)
    const communityConfig = CONFIG.MEETING_CONFIGS['[PUBLIC] llm-d Community Meeting'];
    if (communityConfig) {
      channels.push({
        webhook: communityConfig.slackWebhook,
        name: communityConfig.slackChannel
      });
    }
  }
  
  return channels;
}

/**
 * Extract SIG name from meeting title for a cleaner message
 */
function extractSigName(title) {
  // Extract SIG name from titles like "[PUBLIC] llm-d sig-autoscaling"
  const sigMatch = title.match(/sig-([a-z-]+)/i);
  if (sigMatch) {
    return `sig-${sigMatch[1]}`;
  }
  
  // Handle Community Meeting
  if (title.includes('Community Meeting')) {
    return 'Community Meeting';
  }
  
  // Fallback to full title
  return title;
}

/**
 * Format the Slack message with meeting details
 * Channel parameter determines the message content
 */
function formatSlackMessage(meeting, targetChannel) {
  const sigName = extractSigName(meeting.title);
  const isSigMeeting = sigName.startsWith('sig-');
  const isCommunityChannel = targetChannel === '#community';
  
  // Create the main message text with status
  let messageText;
  
  // Meeting is starting right now
  if (isSigMeeting && isCommunityChannel) {
    // SIG meeting posted to community channel - include channel link
    messageText = `:bell: The weekly public llm-d ${sigName} meeting is starting.\n\nJoin the ${meeting.config.slackChannel} channel for detailed discussion.`;
  } else {
    // SIG meeting posted to SIG channel OR Community meeting - use simple format
    messageText = `:bell: The weekly public llm-d ${sigName} meeting is starting. Join us!`;
  }
  
  // Add Google Meet link if available
  if (meeting.meetLink) {
    messageText += `\n\n:video_camera: <${meeting.meetLink}|Join Google Meet>`;
  }
  
  // Add meeting documents if available
  if (meeting.hasDocuments && meeting.documents.length > 0) {
    messageText += `\n\n:memo: Meeting Notes:`;
    meeting.documents.forEach((doc) => {
      messageText += `\n• <${doc.url}|${doc.displayName}>`;
    });
  }
  
  let message = {
    "text": messageText,
    "blocks": [
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": messageText
        }
      }
    ]
  };
  
  return message;
}

/**
 * Send Slack notification
 */
function sendSlackNotification(webhookUrl, message, channelName) {
  try {
    // In debug mode, send to error channel instead
    const targetWebhook = CONFIG.DEBUG_MODE ? CONFIG.DEFAULT_WEBHOOK : webhookUrl;
    
    // Create a deep copy of the message to avoid modifying the original
    let messageToSend = JSON.parse(JSON.stringify(message));
    
    // Add debug information as a separate block if in debug mode
    if (CONFIG.DEBUG_MODE) {
      // Add debug header to the message text
      const debugPrefix = `🧪 *TEST NOTIFICATION* - This would normally be posted to ${channelName}\n\n`;
      messageToSend.text = debugPrefix + messageToSend.text;
      messageToSend.blocks[0].text.text = debugPrefix + messageToSend.blocks[0].text.text;
    }
    
    const response = UrlFetchApp.fetch(targetWebhook, {
      'method': 'POST',
      'headers': {
        'Content-Type': 'application/json',
      },
      'payload': JSON.stringify(messageToSend)
    });
    
    if (response.getResponseCode() === 200) {
      console.log(`✅ Notification sent successfully to ${channelName}`);
    } else {
      console.error(`❌ Failed to send notification to ${channelName}:`, response.getContentText());
    }
    
  } catch (error) {
    console.error(`❌ Error sending Slack notification to ${channelName}:`, error);
    throw error;
  }
}

/**
 * Send error notification to debug channel
 */
function sendErrorNotification(title, errorMessage) {
  try {
    const message = {
      "text": `❌ Calendar Notifier Error`,
      "blocks": [
        {
          "type": "header",
          "text": {
            "type": "plain_text",
            "text": "❌ Calendar Notifier Error"
          }
        },
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": `*${title}*\n\`\`\`${errorMessage}\`\`\``
          }
        },
        {
          "type": "context",
          "elements": [
            {
              "type": "mrkdwn",
              "text": `🕐 ${new Date().toISOString()}`
            }
          ]
        }
      ]
    };
    
    UrlFetchApp.fetch(CONFIG.DEFAULT_WEBHOOK, {
      'method': 'POST',
      'headers': {
        'Content-Type': 'application/json',
      },
      'payload': JSON.stringify(message)
    });
    
  } catch (error) {
    console.error('❌ Failed to send error notification:', error);
  }
}

/**
 * Setup function to create the automatic trigger
 * Run this once to enable automatic calendar checking on the hour and half hour
 */
function setupCalendarTrigger() {
  try {
    
    // Delete existing triggers for this function
    const triggers = ScriptApp.getProjectTriggers();
    for (const trigger of triggers) {
      if (trigger.getHandlerFunction() === 'checkCalendarAndNotify') {
        ScriptApp.deleteTrigger(trigger);
      }
    }
    
    // Create a trigger that runs every minute for maximum precision
    // This ensures notifications are sent within 30 seconds of meeting start time
    // The function's smart timing logic finds the nearest :00/:30 and prevents duplicate notifications
    ScriptApp.newTrigger('checkCalendarAndNotify')
      .timeBased()
      .everyMinutes(1)
      .create();
    
    console.log('✅ Calendar trigger setup successfully - will run every minute');
    sendDebugMessage('Calendar trigger setup successfully - will run every minute');
    
  } catch (error) {
    console.error('❌ Error setting up calendar trigger:', error);
    sendErrorNotification('Failed to setup calendar trigger', error.toString());
  }
}

/**
 * Test function to show the current timing window logic
 */
function testTimingWindow() {
  console.log('🕐 Testing timing window logic...');
  
  const now = new Date();
  
  // Current logic: Look for meetings starting within tighter notification window
  const searchStart = new Date(now.getTime() - (90 * 1000)); // 90 seconds ago
  const searchEnd = new Date(now.getTime() + (3 * 60 * 1000)); // 3 minutes from now
  const notifyStart = new Date(now.getTime() - (60 * 1000)); // 60 seconds ago (1min early)
  const notifyEnd = new Date(now.getTime() + (15 * 1000)); // 15 seconds from now
  
  console.log(`🕐 Current time: ${now.toLocaleTimeString()}`);
  console.log(`📅 Search window (3min): ${searchStart.toLocaleTimeString()} - ${searchEnd.toLocaleTimeString()}`);
  console.log(`🎯 Notification window (1min early-15sec late): ${notifyStart.toLocaleTimeString()} - ${notifyEnd.toLocaleTimeString()}`);
  console.log(`✅ Only meetings starting within tighter window get notifications`);
  
  // Show examples of what would happen with meetings at different times
  const exampleMeetings = [
    { startTime: new Date(now.getTime() - (2 * 60 * 1000)), desc: '2 minutes ago' },
    { startTime: new Date(now.getTime() - (60 * 1000)), desc: '1 minute ago' },
    { startTime: new Date(now.getTime()), desc: 'right now' },
    { startTime: new Date(now.getTime() + (60 * 1000)), desc: 'in 1 minute' },
    { startTime: new Date(now.getTime() + (2 * 60 * 1000)), desc: 'in 2 minutes' }
  ];
  
  console.log('\n📋 Examples of meeting timing:');
  for (const meeting of exampleMeetings) {
    const timeUntilStart = meeting.startTime.getTime() - now.getTime();
    const secondsUntilStart = Math.floor(timeUntilStart / 1000);
    const wouldNotify = secondsUntilStart >= -60 && secondsUntilStart <= 15;
    
    console.log(`   Meeting starting ${meeting.desc} (${secondsUntilStart}s): ${wouldNotify ? '✅ NOTIFY' : '❌ Skip'}`);
  }
}

/**
 * Test function to run in debug mode
 * Use this to test the calendar checking without waiting for the trigger
 */
function testCalendarNotifier() {
  console.log('🧪 Running calendar notifier in debug mode...');
  
  try {
    // Force debug mode for testing
    checkCalendarAndNotifyDebug();
    console.log('✅ Test completed successfully');
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

/**
 * Debug version of the main function that forces debug mode
 */
function checkCalendarAndNotifyDebug() {
  // Store original debug mode outside try block to ensure it's available in finally
  const originalDebugMode = CONFIG.DEBUG_MODE;
  
  try {
    console.log('🕐 Starting calendar check at:', new Date().toISOString());
    
    // Force debug mode for testing
    CONFIG.DEBUG_MODE = true;
    
    // Get calendar events for the next 30 minutes
    const upcomingMeetings = getUpcomingMeetings();
    
    if (upcomingMeetings.length === 0) {
      console.log('📅 No upcoming meetings found');
      sendDebugMessage('Test run completed - no upcoming meetings found');
      return;
    }
    
    console.log(`📅 Found ${upcomingMeetings.length} upcoming meeting(s)`);
    
    // Process each meeting
    for (const meeting of upcomingMeetings) {
      processMeeting(meeting);
    }
    
  } catch (error) {
    console.error('❌ Error in checkCalendarAndNotifyDebug:', error);
    sendErrorNotification('Debug calendar check failed', error.toString());
  } finally {
    // Restore original debug mode
    CONFIG.DEBUG_MODE = originalDebugMode;
  }
}

/**
 * Send a debug message to verify Slack connectivity
 */
function sendDebugMessage(message) {
  try {
    const debugMessage = {
      "text": "🧪 Calendar Notifier Debug",
      "blocks": [
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": `🧪 *Calendar Notifier Debug*\n${message}\n🕐 ${new Date().toISOString()}`
          }
        }
      ]
    };
    
    UrlFetchApp.fetch(CONFIG.DEFAULT_WEBHOOK, {
      'method': 'POST',
      'headers': {
        'Content-Type': 'application/json',
      },
      'payload': JSON.stringify(debugMessage)
    });
    
  } catch (error) {
    console.error('❌ Failed to send debug message:', error);
  }
}

/**
 * Function to list upcoming events for debugging
 * Use this to see what events are found in your calendar
 */
function debugListUpcomingEvents() {
  try {
    console.log('🔍 Debugging: Listing upcoming events...');
    
    const now = new Date();
    const thirtyMinutesFromNow = new Date(now.getTime() + (30 * 60 * 1000));
    
    const calendar = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
    if (!calendar) {
      console.error(`❌ Calendar not found with ID: ${CONFIG.CALENDAR_ID}`);
      return;
    }
    
    const events = calendar.getEvents(now, thirtyMinutesFromNow);
    
    console.log(`📅 Found ${events.length} events in the next 30 minutes:`);
    
    for (const event of events) {
      console.log('='.repeat(50));
      console.log(`📋 Event: ${event.getTitle()}`);
      console.log(`🕐 Start: ${event.getStartTime()}`);
      console.log(`📍 Location: ${event.getLocation()}`);
      console.log(`📝 Description (first 500 chars):`);
      const desc = event.getDescription() || '';
      console.log(desc.substring(0, 500) + (desc.length > 500 ? '...' : ''));
      console.log(`📏 Full description length: ${desc.length} characters`);
      
      // Extract meeting details with full debugging
      const meetingDetails = extractMeetingDetails(event);
      console.log(`🎥 Meet Link: ${meetingDetails.meetLink || 'None'}`);
      console.log(`📎 Documents: ${meetingDetails.documents.length}`);
      if (meetingDetails.documents.length > 0) {
        meetingDetails.documents.forEach((doc, index) => {
          console.log(`   ${index + 1}. ${doc.displayName} (${doc.url})`);
        });
      }
      console.log('='.repeat(50));
    }
    
  } catch (error) {
    console.error('❌ Error debugging events:', error);
  }
}

/**
 * Test function that finds the next upcoming meeting and sends a notification
 * Searches the next 7 days to find a matching meeting
 * This helps you see what the actual Slack message will look like
 */
function testNextMeetingNotification() {
  // Store original debug mode outside try block to ensure it's available in catch
  let originalDebugMode;
  
  try {
    console.log('🧪 Testing notification for next upcoming meeting...');
    
    // Check config first
    if (typeof CONFIG === 'undefined') {
      console.error('❌ CONFIG is not defined - create config.js first');
      return;
    }
    
    // Force debug mode for testing
    originalDebugMode = CONFIG.DEBUG_MODE;
    CONFIG.DEBUG_MODE = true;
    
    // Look for meetings in the next 7 days to find upcoming meetings
    const now = new Date();
    const next7Days = new Date(now.getTime() + (7 * 24 * 60 * 60 * 1000));
    
    console.log(`🔍 Searching for meetings between ${now.toLocaleString()} and ${next7Days.toLocaleString()}`);
    
    const calendar = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
    if (!calendar) {
      console.error(`❌ Calendar not found with ID: ${CONFIG.CALENDAR_ID}`);
      return;
    }
    
    const events = calendar.getEvents(now, next7Days);
    console.log(`📅 Found ${events.length} total events in next 7 days`);
    
    // Find the next meeting that matches our prefixes
    let nextMeeting = null;
    
    for (const event of events) {
      const title = event.getTitle();
      const startTime = event.getStartTime();
      
      // Skip meetings with "Canceled" in the title (case-insensitive)
      if (title.toLowerCase().includes('canceled')) {
        console.log(`⏭️ Skipping canceled meeting: "${title}"`);
        continue;
      }
      
      const meetingDetails = extractMeetingDetails(event);
      
      console.log(`📋 Checking event: "${title}" at ${startTime.toLocaleString()}`);
      
      // Check if this meeting matches any of our configured prefixes
      const matchedConfig = findMatchingMeetingConfig(title);
      
      if (matchedConfig) {
        nextMeeting = {
          title: title,
          startTime: startTime,
          meetLink: meetingDetails.meetLink,
          documents: meetingDetails.documents,
          hasDocuments: meetingDetails.hasDocuments,
          config: matchedConfig,
          event: event
        };
        console.log(`✅ Found matching meeting: ${title}`);
        console.log(`📎 Documents found: ${meetingDetails.documents.length}`);
        break;
      } else {
        console.log(`⏭️ Skipping "${title}" - doesn't match any configured prefixes`);
      }
    }
    
    if (!nextMeeting) {
      console.log('⚠️ No matching meetings found in the next 7 days');
      console.log('💡 Available prefixes in your config:');
      Object.keys(CONFIG.MEETING_CONFIGS).forEach(prefix => {
        console.log(`   - "${prefix}"`);
      });
      return;
    }
    
    console.log('🎯 Testing notification for:', nextMeeting.title);
    console.log('📅 Meeting time:', nextMeeting.startTime.toLocaleString());
    console.log('🎥 Meet link:', nextMeeting.meetLink || 'Not found');
    console.log('📎 Documents attached:', nextMeeting.documents.length);
    if (nextMeeting.documents.length > 0) {
      nextMeeting.documents.forEach((doc, index) => {
        console.log(`   ${index + 1}. ${doc.displayName} (${doc.url})`);
      });
    }
    
    // Create and log the message payload (for community channel example)
    const message = formatSlackMessage(nextMeeting, '#community');
    console.log('📨 Message payload (for #community channel):');
    console.log(JSON.stringify(message, null, 2));
    
    // Send the test notification
    console.log('📤 Sending test notification...');
    processMeeting(nextMeeting);
    
    console.log('✅ Test notification sent! Check your error channel to see the formatted message.');
    
    // Restore original debug mode
    CONFIG.DEBUG_MODE = originalDebugMode;
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    // Restore debug mode even if error occurs
    if (typeof originalDebugMode !== 'undefined') {
      CONFIG.DEBUG_MODE = originalDebugMode;
    }
  }
}

/**
 * Daily cleanup function - more thorough cleanup at end of business day
 * Call this once per day (e.g., at 11:59 PM) to ensure storage stays clean
 */
function dailyCleanupNotificationRecords() {
  try {
    console.log('🌅 Running daily cleanup of notification records...');
    
    const properties = PropertiesService.getScriptProperties();
    const allProperties = properties.getProperties();
    const now = new Date();
    
    // For daily cleanup, remove anything older than 6 hours (very aggressive)
    const cutoffTime = new Date(now.getTime() - (6 * 60 * 60 * 1000));
    
    let cleanedCount = 0;
    let totalRecords = 0;
    
    for (const [key, value] of Object.entries(allProperties)) {
      if (key.startsWith('notified_')) {
        totalRecords++;
        try {
          const recordData = JSON.parse(value);
          const notifiedTime = new Date(recordData.notifiedAt);
          
          if (notifiedTime < cutoffTime) {
            properties.deleteProperty(key);
            cleanedCount++;
            console.log(`🌅 Daily cleanup: ${recordData.meetingTitle}`);
          }
        } catch (parseError) {
          // Remove corrupted records
          properties.deleteProperty(key);
          cleanedCount++;
          console.log(`🌅 Daily cleanup: Removed corrupted record ${key}`);
        }
      }
    }
    
    console.log(`🌅 Daily cleanup completed: Removed ${cleanedCount}/${totalRecords} records`);
    
    // Report storage health - only alert if there are issues
    const remainingRecords = totalRecords - cleanedCount;
    if (remainingRecords > 30) {
      sendDebugMessage(`⚠️ Storage still high after daily cleanup: ${remainingRecords}/50 records remaining`);
    } else {
      console.log(`✅ Storage healthy after daily cleanup: ${remainingRecords}/50 records`);
    }
    
  } catch (error) {
    console.error('❌ Error in daily cleanup:', error);
    sendErrorNotification('Daily cleanup failed', error.toString());
  }
}

/**
 * Setup function to create both regular and daily cleanup triggers
 * Run this once to enable automatic cleanup
 */
function setupCleanupTriggers() {
  try {
    console.log('⚙️ Setting up cleanup triggers...');
    
    // Delete existing cleanup triggers
    const triggers = ScriptApp.getProjectTriggers();
    for (const trigger of triggers) {
      if (trigger.getHandlerFunction() === 'dailyCleanupNotificationRecords') {
        ScriptApp.deleteTrigger(trigger);
      }
    }
    
    // Create daily cleanup trigger (runs at 11:30 PM every day)
    ScriptApp.newTrigger('dailyCleanupNotificationRecords')
      .timeBased()
      .everyDays(1)
      .atHour(23)  // 11 PM
      .nearMinute(30) // 11:30 PM
      .create();
    
    console.log('✅ Daily cleanup trigger created - will run at 11:30 PM every day');
    
  } catch (error) {
    console.error('❌ Error setting up cleanup triggers:', error);
    sendErrorNotification('Failed to setup cleanup triggers', error.toString());
  }
}

/**
 * Clear all notification records (for testing purposes)
 * Use this if you want to test notifications for meetings that have already been notified
 */
function clearAllNotificationRecords() {
  try {
    console.log('🧪 Clearing all notification records...');
    
    const properties = PropertiesService.getScriptProperties();
    const allProperties = properties.getProperties();
    let clearedCount = 0;
    
    for (const key of Object.keys(allProperties)) {
      if (key.startsWith('notified_')) {
        properties.deleteProperty(key);
        clearedCount++;
      }
    }
    
    console.log(`✅ Cleared ${clearedCount} notification record(s)`);
    sendDebugMessage(`Cleared ${clearedCount} notification records for testing`);
    
  } catch (error) {
    console.error('❌ Error clearing notification records:', error);
  }
}

/**
 * Monitor PropertiesService storage health and usage
 */
function monitorStorageHealth() {
  try {
    console.log('📊 Monitoring PropertiesService storage health...');
    
    const properties = PropertiesService.getScriptProperties();
    const allProperties = properties.getProperties();
    
    let notificationRecords = 0;
    let otherProperties = 0;
    let oldestRecord = null;
    let newestRecord = null;
    let corruptedRecords = 0;
    
    for (const [key, value] of Object.entries(allProperties)) {
      if (key.startsWith('notified_')) {
        notificationRecords++;
        try {
          const recordData = JSON.parse(value);
          const notifiedTime = new Date(recordData.notifiedAt);
          
          if (!oldestRecord || notifiedTime < oldestRecord.time) {
            oldestRecord = { time: notifiedTime, title: recordData.meetingTitle };
          }
          if (!newestRecord || notifiedTime > newestRecord.time) {
            newestRecord = { time: notifiedTime, title: recordData.meetingTitle };
          }
        } catch (parseError) {
          corruptedRecords++;
        }
      } else {
        otherProperties++;
      }
    }
    
    const totalProperties = notificationRecords + otherProperties;
    const utilizationPercent = Math.round((totalProperties / 50) * 100);
    
    console.log('='.repeat(50));
    console.log('📊 PROPERTIES SERVICE STORAGE REPORT');
    console.log('='.repeat(50));
    console.log(`📦 Total properties: ${totalProperties}/50 (${utilizationPercent}% full)`);
    console.log(`📝 Notification records: ${notificationRecords}`);
    console.log(`⚙️  Other properties: ${otherProperties}`);
    console.log(`❌ Corrupted records: ${corruptedRecords}`);
    
    if (oldestRecord) {
      const hoursOld = Math.floor((new Date() - oldestRecord.time) / (1000 * 60 * 60));
      console.log(`⏰ Oldest record: ${oldestRecord.title} (${hoursOld}h old)`);
    }
    
    if (newestRecord) {
      const minutesOld = Math.floor((new Date() - newestRecord.time) / (1000 * 60));
      console.log(`⏰ Newest record: ${newestRecord.title} (${minutesOld}m old)`);
    }
    
    // Health assessment
    let healthStatus = '🟢 HEALTHY';
    let recommendations = [];
    
    if (utilizationPercent >= 90) {
      healthStatus = '🔴 CRITICAL';
      recommendations.push('Run emergency cleanup immediately');
      recommendations.push('Consider shorter retention period');
    } else if (utilizationPercent >= 70) {
      healthStatus = '🟡 WARNING';
      recommendations.push('Monitor closely');
      recommendations.push('Consider running daily cleanup more frequently');
    } else if (utilizationPercent >= 50) {
      healthStatus = '🟡 MODERATE';
      recommendations.push('Storage usage is moderate');
    }
    
    if (corruptedRecords > 0) {
      recommendations.push(`Clean up ${corruptedRecords} corrupted records`);
    }
    
    console.log(`📊 Health status: ${healthStatus}`);
    
    if (recommendations.length > 0) {
      console.log('💡 Recommendations:');
      recommendations.forEach((rec, index) => {
        console.log(`   ${index + 1}. ${rec}`);
      });
    }
    
    console.log('='.repeat(50));
    
    // Send Slack notification if storage is getting full
    if (utilizationPercent >= 80) {
      sendDebugMessage(`⚠️ PropertiesService storage is ${utilizationPercent}% full (${totalProperties}/50 properties)\nOldest record: ${oldestRecord?.title} (${Math.floor((new Date() - oldestRecord?.time) / (1000 * 60 * 60))}h old)`);
    }
    
  } catch (error) {
    console.error('❌ Error monitoring storage health:', error);
  }
}

/**
 * List all current notification records (for debugging)
 */
function listNotificationRecords() {
  try {
    console.log('📋 Listing all notification records...');
    
    const properties = PropertiesService.getScriptProperties();
    const allProperties = properties.getProperties();
    let recordCount = 0;
    
    for (const [key, value] of Object.entries(allProperties)) {
      if (key.startsWith('notified_')) {
        try {
          const recordData = JSON.parse(value);
          const hoursOld = Math.floor((new Date() - new Date(recordData.notifiedAt)) / (1000 * 60 * 60));
          console.log(`📝 ${recordData.meetingTitle} - ${hoursOld}h ago (${recordData.notifiedAt})`);
          recordCount++;
        } catch (parseError) {
          console.log(`❌ Corrupted record: ${key}`);
          recordCount++;
        }
      }
    }
    
    console.log(`📊 Total notification records: ${recordCount}/50`);
    
    if (recordCount === 0) {
      console.log('✨ No notification records found - all meetings will trigger notifications');
    }
    
    // Show storage utilization
    const utilizationPercent = Math.round((recordCount / 50) * 100);
    console.log(`📦 Storage utilization: ${utilizationPercent}%`);
    
  } catch (error) {
    console.error('❌ Error listing notification records:', error);
  }
}

/**
 * Test function to verify config is properly set up
 * Run this to verify your config.js is working correctly
 */
function testConfig() {
  try {
    console.log('🧪 Testing configuration...');
    
    // Check if CONFIG is defined
    if (typeof CONFIG === 'undefined') {
      console.error('❌ CONFIG is not defined');
      console.log('💡 Make sure you have created config.js in this script with your configuration');
      return;
    }
    
    console.log('✅ CONFIG is defined');
    
    // Debug: Show all available config keys
    console.log('📋 Available config keys:', Object.keys(CONFIG));
    
    // Check specific fields
    console.log('Calendar ID:', CONFIG.CALENDAR_ID || 'NOT SET');
    console.log('Default webhook:', CONFIG.DEFAULT_WEBHOOK || 'NOT SET');
    console.log('Debug mode:', CONFIG.DEBUG_MODE);
    
    if (CONFIG.MEETING_CONFIGS) {
      console.log('Meeting configs:', Object.keys(CONFIG.MEETING_CONFIGS).length);
    } else {
      console.log('Meeting configs: NOT SET');
    }
    
    // Verify required fields
    const requiredFields = ['CALENDAR_ID', 'DEFAULT_WEBHOOK', 'MEETING_CONFIGS'];
    const missingFields = requiredFields.filter(field => !CONFIG[field]);
    
    if (missingFields.length > 0) {
      console.warn('⚠️ Missing required fields in config:', missingFields);
      console.log('');
      console.log('🔧 TO FIX: Add these to your config.js:');
      if (missingFields.includes('CALENDAR_ID')) {
        console.log('   CALENDAR_ID: "your-calendar-id@group.calendar.google.com",');
      }
      console.log('');
      console.log('💡 Your config.js should look like:');
      console.log('const CONFIG = {');
      console.log('  DEBUG_MODE: false,');
      console.log('  CALENDAR_ID: "your-calendar-id@group.calendar.google.com",');
      console.log('  MEETING_CONFIGS: { ... },');
      console.log('  DEFAULT_WEBHOOK: "your-webhook-url"');
      console.log('};');
    } else {
      console.log('✅ All required configuration fields are present');
      
      // Send test message to verify webhook connectivity
      if (CONFIG.DEFAULT_WEBHOOK) {
        sendDebugMessage('Configuration test successful - config.js is working!');
      }
    }
    
  } catch (error) {
    console.error('❌ Configuration test failed:', error);
    console.log('📋 Troubleshooting checklist:');
    console.log('1. Create a config.js file in this Google Apps Script project');
    console.log('2. Copy config.example.js and update with your values');
    console.log('3. Make sure CONFIG is defined as a global variable');
    console.log('4. Include all required fields: CALENDAR_ID, DEFAULT_WEBHOOK, MEETING_CONFIGS');
  }
}
