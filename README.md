# Divvy Station Bluesky Bot

A bot that monitors Chicago's Divvy bike share system and posts updates to Bluesky when new stations are added or existing stations are electrified.

## Features

- Monitors Chicago's Divvy bike share system using the City of Chicago's open data API
- Detects new station additions and station electrification
- Generates both static and interactive maps showing station locations
- Posts updates to Bluesky with station details and map images
- Includes Google Street View images of new stations
- Configurable post limits for new station announcements
- Test mode for previewing posts without sending them
- Ability to force post specific stations
- Comprehensive logging system
- Data validation for station information

## Requirements

### Python Requirements
- Python 3.8+
- Required Python packages (see requirements.txt)

### System Dependencies
#### Ubuntu/Debian:
```bash
sudo apt-get update
sudo apt-get install python3-dev python3-pip \
    libgdal-dev libspatialindex-dev \
    libfreetype6-dev libharfbuzz-dev \
    libjpeg-dev libpng-dev
```

#### macOS:
```bash
brew install gdal spatialindex freetype harfbuzz
```

### API Keys and Credentials
- Bluesky account credentials
- Google Maps API key with Street View API enabled
  - Enable the Street View Static API in Google Cloud Console
  - Set up billing for the Google Cloud Project

## Setup

1. Clone the repository

2. Create a virtual environment:
   ```bash
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   ```

3. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

4. Copy .env.example to .env and configure environment variables:
   ```bash
   cp .env.example .env
   ```
   Required variables:
   - `BLUESKY_HANDLE`: Your Bluesky handle (e.g., user.bsky.social)
   - `BLUESKY_APP_PASSWORD`: Your Bluesky app password
   - `GOOGLE_MAPS_API_KEY`: Google Maps API key for Street View images
   - `DB_PATH`: SQLite database path (default: data/divvy_stations.db)
   - `LOG_LEVEL`: Logging level (default: INFO)

## Configuration

The bot is configured through `config.yaml`:

### Features
- `bluesky_posting`: Enable/disable posting to Bluesky
- `test_mode`: Preview posts without sending them
- `limit_new_station_posts`: Maximum number of new station posts per run (0 for unlimited)
- `streetview_images`: Include Google Street View images in posts
- `force_station_id`: Force post a specific station by ID

### API Settings
- `page_size`: Number of records per API page
- `max_retries`: Number of retries on API failure
- `timeouts`: Configurable timeouts for API calls

### Logging
- Configurable logging levels and formats
- Logs are stored in the `logs` directory

## Usage

Run the bot:
```bash
python src/main.py
```

### Test Mode
To test the bot without posting to Bluesky:
1. Set `test_mode: true` in config.yaml
2. Run the bot normally - it will select a random station and simulate posting

### Force Posting
To force post a specific station:
1. Uncomment and set `force_station_id` in config.yaml
2. Run the bot normally

## Data Source

This bot uses the City of Chicago's Divvy Bicycle Stations dataset:
https://data.cityofchicago.org/api/odata/v4/bbyy-e7gq

Electric stations are identified by:
- An asterisk (*) at the end of the station name
- The word "charging" in the station's short name

## License

MIT
