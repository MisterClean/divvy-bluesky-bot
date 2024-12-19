import logging
import os
import yaml
from database import Database
from divvy_api import DivvyAPI
from map_generator import MapGenerator
from bluesky_poster import BlueskyPoster
from dotenv import load_dotenv
import time

# Create necessary directories
os.makedirs('logs', exist_ok=True)
os.makedirs('data', exist_ok=True)

# Set up logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('logs/divvy_bot.log'),
        logging.StreamHandler()
    ]
)

# Set logging levels for different modules
logging.getLogger('divvy_api').setLevel(logging.INFO)
logging.getLogger('urllib3').setLevel(logging.WARNING)
logging.getLogger('matplotlib').setLevel(logging.WARNING)

logger = logging.getLogger(__name__)

class DivvyBot:
    def __init__(self):
        # Load config
        with open('config.yaml', 'r') as f:
            self.config = yaml.safe_load(f)
            
        # Initialize core components
        self.db = Database()
        self.api = DivvyAPI()
        self.map_gen = MapGenerator()
        self._poster = None
        
        # Track station changes
        self.new_stations = 0
        self.electrified_stations = 0
        
        # Check if this is first run
        self.is_first_run = not os.path.exists('data/divvy_stations.db')
        
    @property
    def poster(self):
        """
        Lazy-load the BlueskyPoster only when needed
        """
        if self._poster is None and not self.is_first_run:
            test_mode = self.config['features'].get('test_mode', False)
            self._poster = BlueskyPoster(test_mode=test_mode)
        return self._poster
    
    def validate_station_data(self, station_data):
        """
        Validate station data before inserting/updating
        """
        required_fields = ['id', 'station_name', 'short_name', 'total_docks', 'docks_in_service', 'status', 'latitude', 'longitude']
        for field in required_fields:
            if field not in station_data:
                raise ValueError(f"Missing required field: {field}")
            
        if not isinstance(station_data['id'], str):
            raise ValueError("Station ID must be a string")
        if not isinstance(station_data['total_docks'], int):
            raise ValueError("Total docks must be an integer")
        if not isinstance(station_data['docks_in_service'], int):
            raise ValueError("Docks in service must be an integer")
        if not isinstance(station_data['latitude'], float):
            raise ValueError("Latitude must be a float")
        if not isinstance(station_data['longitude'], float):
            raise ValueError("Longitude must be a float")
            
        # Basic range checks
        if not (41.6 <= station_data['latitude'] <= 42.1):  # Chicago latitude range
            raise ValueError(f"Latitude {station_data['latitude']} outside Chicago range")
        if not (-87.9 <= station_data['longitude'] <= -87.5):  # Chicago longitude range
            raise ValueError(f"Longitude {station_data['longitude']} outside Chicago range")
        if station_data['total_docks'] <= 0:
            raise ValueError("Total docks must be positive")
    
    def process_stations(self):
        """
        Fetch current stations and process any changes
        """
        logger.info("Fetching station data...")
        stations = self.api.get_stations()
        
        # Reset counters
        self.new_stations = 0
        self.electrified_stations = 0
        
        for station_data in stations:
            try:
                # Add or update station in database
                result = self.db.add_or_update_station(station_data)
                
                if result == 'new':
                    self.new_stations += 1
                elif result == 'electrified':
                    self.electrified_stations += 1
                
                if result and not self.is_first_run and self.config['features']['bluesky_posting']:
                    # Get full station object from database
                    station = self.db.get_station(station_data['id'])
                    
                    # Generate map
                    logger.debug(f"Generating map for station {station.station_name}")
                    map_path = self.map_gen.generate_station_map(station)
                    
                    # Post update
                    if result == 'new':
                        self.poster.post_new_station(station, map_path)
                    elif result == 'electrified':
                        self.poster.post_electrified_station(station, map_path)
                    
                    # Clean up map file
                    os.remove(map_path)
                    
            except Exception as e:
                logger.error(f"Error processing station {station_data.get('station_name', 'unknown')}: {e}")
        
        # Log summary
        if self.is_first_run:
            logger.info(f"First run completed: Loaded {len(stations)} stations")
        else:
            changes = []
            if self.new_stations > 0:
                changes.append(f"{self.new_stations} new")
            if self.electrified_stations > 0:
                changes.append(f"{self.electrified_stations} electrified")
            if changes:
                logger.info(f"Changes detected: {', '.join(changes)} stations")
            else:
                logger.info("No changes detected")
    
    def run(self):
        """
        Main bot loop
        """
        logger.info("Starting Divvy Station Bot")
        
        while True:
            try:
                self.process_stations()
                # Wait 15 minutes before checking again
                time.sleep(900)
            except Exception as e:
                logger.error(f"Error in main loop: {e}")
                time.sleep(60)  # Wait a minute before retrying on error

def main():
    load_dotenv()
    bot = DivvyBot()
    bot.run()

if __name__ == "__main__":
    main()
