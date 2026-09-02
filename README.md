# llm-d-meeting-organizer

Google Apps Script solutions for meeting management, including file organization and calendar-based notifications.

## Scripts Included

### Meeting File Organizer (`llm-d-meeting-organizer.js`)
- Detects meeting-series subfolders inside the "Google Meet" source folder that match configured meeting patterns (e.g., `[PUBLIC] llm-d sig-*`) and processes the files inside them
- Requires both "Notes by Gemini" and "Recording" files for regular meetings
- Processes chat files independently without requiring pairs
- Moves files to exact target folders in Google Drive
- Sends Slack notifications to corresponding channels via webhooks
- Sends error notifications to configured channel for issues
- Runs every 15 minutes via time-based trigger
- Debug mode available for testing without moving files

### Calendar Meeting Notifier (`calendar-meeting-notifier.js`)
- Monitors shared Google Calendar and sends Slack notifications when meetings start
- Notifies at meeting start time (1 minute early to 15 seconds late) with precise timing
- Automatically ignores meetings with "Canceled" in the title (case-insensitive)
- Prevents duplicate notifications with intelligent tracking system
- Extracts Google Meet links and meeting documents from calendar events  
- Sends different messages to SIG channels vs community channel
- Smart storage management prevents PropertiesService overflow
- Uses Calendar API and Drive API for meeting data
- Comprehensive testing and monitoring functions

## Quick Start

### File Organizer Setup
1. **Copy the script**: Go to [script.google.com](https://script.google.com) and create a new project
2. **Paste the code**: Copy all contents from `llm-d-meeting-organizer.js`
3. **Create config**: Add a new file called `config.js` with your folder IDs and webhook URLs (see `config.example.js`)
4. **Test first**: Run `testDebugMode()` to verify configuration without moving files
5. **Run setup**: Execute `setupAutomaticTrigger()` to enable automatic scheduling

**Full setup instructions**: See [LLM-D_MEETING_ORGANIZER.md](./LLM-D_MEETING_ORGANIZER.md)

### Calendar Notifier Setup
1. **Create new script**: Create a Google Apps Script project and paste `calendar-meeting-notifier.js`
2. **Enable APIs**: Add Google Calendar API and Google Drive API in project services
3. **Create config**: Copy `config.example.js` to create `config.js` with your calendar ID and webhooks
4. **Test timing logic**: Run `testTimingWindow()` to see how meetings are detected at start time
5. **Test configuration**: Run `testConfig()` to verify all settings are correct
6. **Test with real data**: Run `testNextMeetingNotification()` to test with your actual next meeting
7. **Setup triggers**: Execute `setupCalendarTrigger()` for main notifications + `setupCleanupTriggers()` for storage management
8. **Monitor storage**: Use `monitorStorageHealth()` to check PropertiesService usage
9. **Verify operation**: Check that triggers are created and monitor for live notifications

**Full setup instructions**: See [CALENDAR_MEETING_NOTIFIER.md](./CALENDAR_MEETING_NOTIFIER.md)

## File Processing

The application:

1. Searches the "Google Meet" source folder for meeting-series subfolders matching configured meeting patterns (e.g., `[PUBLIC] llm-d sig-*`, `[PUBLIC] llm-d Community Meeting`) and reads the files inside them
2. Groups files by meeting configuration
3. Only processes complete pairs where both "Notes by Gemini" and "Recording" files are present
4. Processes chat files immediately without requiring pairs
5. Moves all matching files to the exact target folder specified in configuration
6. Posts notification to the corresponding Slack channel via webhook (skips notifications for Chat files)
7. Supports debug mode for safe testing without file movement

## Prerequisites

- Google Workspace account
- Slack workspace with webhook permissions
- Shared Google Drive folder for organizing files

## Files in This Repository

### Scripts
- `llm-d-meeting-organizer.js` - File organizer Google Apps Script implementation
- `calendar-meeting-notifier.js` - Calendar notification Google Apps Script implementation

### Configuration
- `config.example.js` - Configuration template for both scripts
- `slack-app-manifest.yaml` - Slack app configuration for webhook setup

### Documentation
- `LLM-D_MEETING_ORGANIZER.md` - File organizer setup instructions
- `CALENDAR_MEETING_NOTIFIER.md` - Calendar notifier setup instructions
- `README.md` - This overview

## Architecture

### Calendar Timing System

The Calendar Notifier sends notifications exactly when meetings start:

1. **Precise Timing**: Runs every minute and notifies when meetings are starting (1 minute early to 15 seconds late)
2. **Smart Detection**: Finds meetings starting within current timeframe, accounting for trigger variations
3. **Duplicate Prevention**: Intelligent tracking prevents multiple notifications for the same meeting
4. **Storage Management**: Multi-layered cleanup system prevents PropertiesService overflow

**Examples:**
- Meeting at 2:00:00 PM gets notified between 1:59:00-2:00:15 PM (when trigger first runs in that window)
- Each meeting gets exactly one notification when it starts
- Old tracking records automatically cleaned up

## Security & Permissions

### File Organizer Requirements:
- Google Drive: Read/write access to organize meeting files
- Slack: Webhook URLs for file organization notifications

### Calendar Notifier Requirements:
- Google Calendar API: Read calendar events and conference data
- Google Drive API: Read file names for meeting documents  
- Slack: Webhook URLs for meeting notifications

Both scripts use secure webhook-based Slack integration and read-only calendar access.
