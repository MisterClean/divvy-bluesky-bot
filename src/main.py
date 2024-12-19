import logging
import os
import yaml
from database import Database
from divvy_api import DivvyAPI
from map_generator import MapGenerator
from bluesky_poster import BlueskyPoster
from dotenv import load_dotenv
import time
import random

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
        
        # Collect new stations first
        new_station_ids = []
        
        for station_data in stations:
            try:
                # Add or update station in database
                result = self.db.add_or_update_station(station_data)
                
                # Track changes but don't post during first run
                if result == 'new':
                    self.new_stations += 1
                    if not self.is_first_run:
                        new_station_ids.append(station_data['id'])
                elif result == 'electrified':
                    self.electrified_stations += 1
                    # Always post electrified stations since this can only happen to existing stations
                    if self.config['features']['bluesky_posting']:
                        station = self.db.get_station(station_data['id'])
                        static_map, interactive_map = self.map_gen.generate_station_map(station)
                        self.poster.post_electrified_station(station, static_map)
                        os.remove(static_map)
                        os.remove(interactive_map)
                    
            except Exception as e:
                logger.error(f"Error processing station {station_data.get('station_name', 'unknown')}: {e}")
        
        # Post about new stations
        if new_station_ids and not self.is_first_run and self.config['features']['bluesky_posting']:
            # Get post limit from config (0 means no limit)
            post_limit = self.config['features'].get('limit_new_station_posts', 10)
            
            # Apply limit if configured
            if post_limit > 0:
                stations_to_post = new_station_ids[:post_limit]
                skipped_count = len(new_station_ids) - len(stations_to_post)
            else:
                stations_to_post = new_station_ids
                skipped_count = 0
            
            for station_id in stations_to_post:
                try:
                    station = self.db.get_station(station_id)
                    static_map, interactive_map = self.map_gen.generate_station_map(station)
                    self.poster.post_new_station(station, static_map)
                    os.remove(static_map)
                    os.remove(interactive_map)
                except Exception as e:
                    logger.error(f"Error posting new station {station_id}: {e}")
            
            if skipped_count > 0:
                logger.warning(f"Skipped posting about {skipped_count} new stations due to {post_limit} station limit")
        
        # Log summary
        if self.is_first_run:
            logger.info(f"First run completed: Loaded {len(stations)} stations")
        else:
            changes = []
            if self.new_stations > 0:
                post_limit = self.config['features'].get('limit_new_station_posts', 10)
                if post_limit > 0:
                    posted = min(self.new_stations, post_limit)
                    changes.append(f"{self.new_stations} new (posted {posted})")
                else:
                    changes.append(f"{self.new_stations} new (posted all)")
            if self.electrified_stations > 0:
                changes.append(f"{self.electrified_stations} electrified")
            if changes:
                logger.info(f"Changes detected: {', '.join(changes)} stations")
            else:
                logger.info("No changes detected")
    
    def post_forced_station(self, station_id):
        """
        Post a specific station to Bluesky
        """
        try:
            station = self.db.get_station(station_id)
            if not station:
                logger.error(f"Forced station ID {station_id} not found in database")
                return
                
            logger.info(f"Posting forced station: {station.station_name}")
            static_map, interactive_map = self.map_gen.generate_station_map(station)
            
            # Force test_mode=false to actually post to Bluesky
            if self._poster is None:
                self._poster = BlueskyPoster(test_mode=False)
            self._poster.post_new_station(station, static_map)
            
            # Clean up map files
            os.remove(static_map)
            os.remove(interactive_map)
            
            logger.info("Forced station post completed")
        except Exception as e:
            logger.error(f"Error posting forced station: {e}")
            raise

    def run(self):
        """
        Single run of the bot for cron job execution
        """
        logger.info("Starting Divvy Station Bot")
        
        try:
            # Check if we should force a specific station
            force_station_id = self.config['features'].get('force_station_id')
            if force_station_id:
                self.post_forced_station(force_station_id)
            else:
                self.process_stations()
            logger.info("Completed processing stations")
        except Exception as e:
            logger.error(f"Error during station processing: {e}")
            raise  # Re-raise to ensure non-zero exit code
        finally:
            # Cleanup
            if self.db:
                self.db.close()

    def test_random_station(self):
        """
        Test mode that picks a random station and posts it to Bluesky
        """
        logger.info("Running in test mode - posting random station")
        
        try:
            # Get all stations
            stations = self.db.get_all_stations()
            if not stations:
                logger.error("No stations found in database")
                return
                
            # Pick random station
            station = random.choice(stations)
            logger.info(f"Selected random station: {station.station_name}")
            
            # Generate maps
            logger.debug(f"Generating maps for station {station.station_name}")
            static_map, interactive_map = self.map_gen.generate_station_map(station)
            
            # Force test_mode=false to actually post to Bluesky
            if self._poster is None:
                self._poster = BlueskyPoster(test_mode=False)
            self._poster.post_new_station(station, static_map)
            
            # Clean up map files
            os.remove(static_map)
            os.remove(interactive_map)
            
            logger.info("Test post completed")
        except Exception as e:
            logger.error(f"Error in test mode: {e}")
            raise
        finally:
            # Cleanup
            if self.db:
                self.db.close()

def main():
    load_dotenv()
    bot = DivvyBot()
    
    # Check if test mode is enabled
    if bot.config['features']['test_mode']:
        bot.test_random_station()
    else:
        bot.run()

if __name__ == "__main__":
    main()
