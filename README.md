# Sui Events Dashboard

A comprehensive event management system that synchronizes event data between Luma, Supabase, and Google Sheets.

## Features

- **Multi-platform Data Synchronization**
  - Syncs event data from Luma to Supabase database
  - Syncs event data from Luma to Google Sheets
  - Maintains data consistency across all platforms

- **Event Management**
  - Fetches all events from Luma
  - Retrieves detailed event information
  - Manages event hosts and guests
  - Handles event updates and modifications

- **Automated Synchronization**
  - Scheduled sync operations
  - Real-time data updates
  - Error handling and logging
  - Status reporting

## Technical Architecture

### Core Components

1. **Luma Service**
   - Handles all Luma API interactions
   - Fetches events, hosts, and guests data
   - Manages event details and updates

2. **Supabase Service**
   - Database operations and management
   - Data synchronization and storage
   - Event data persistence

3. **Google Sheets Service**
   - Spreadsheet integration
   - Data formatting and organization
   - Real-time updates

### Data Flow

1. Event data is fetched from Luma
2. Data is processed and validated
3. Synchronization occurs in parallel:
   - Data is synced to Supabase
   - Data is synced to Google Sheets
4. Status and results are reported

## Setup

### Prerequisites

- Node.js environment
- Luma API access
- Supabase account and credentials
- Google Sheets API access

### Environment Variables

```env
LUMA_API_KEY=your_luma_api_key
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_KEY=your_supabase_service_key
GOOGLE_SHEET_ID=your_google_sheet_id
GOOGLE_CLIENT_EMAIL=your_google_client_email
GOOGLE_PRIVATE_KEY=your_google_private_key
```

### Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Configure environment variables
4. Start the service:
   ```bash
   npm start
   ```

## Usage

### Manual Sync

The system can be triggered manually through the API endpoint:

```bash
curl -X POST http://your-api-endpoint/sync
```

### Scheduled Sync

The system includes an automated scheduled sync feature that runs at configured intervals.

## Error Handling

The system includes comprehensive error handling:

- Environment variable validation
- API request error handling
- Data validation
- Sync status reporting
- Detailed error logging

## Monitoring

The system provides detailed logging for:

- Sync operations
- Error conditions
- Success status
- Data statistics

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details. 