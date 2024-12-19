# Divvy Station Bluesky Bot

A bot that monitors Chicago's Divvy bike share system and posts updates to Bluesky when new stations are added or existing stations are electrified.

## Features

- Monitors Chicago's Divvy bike share system using the City of Chicago's open data API
- Detects new station additions and station electrification
- Generates maps showing station locations
- Posts updates to Bluesky with station details and map images

## Requirements

- Python 3.8+
- Bluesky account
- Required Python packages (see requirements.txt)

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
4. Copy .env.example to .env and fill in your Bluesky credentials:
   ```bash
   cp .env.example .env
   ```

## Usage

Run the bot:
```bash
python src/main.py
```

## Data Source

This bot uses the City of Chicago's Divvy Bicycle Stations dataset:
https://data.cityofchicago.org/api/odata/v4/bbyy-e7gq

Electric stations are identified by:
- An asterisk (*) at the end of the station name
- The word "charging" in the station's short name

## License

MIT
