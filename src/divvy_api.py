import requests
from datetime import datetime
import logging
import yaml
import time

logger = logging.getLogger(__name__)

class DivvyAPI:
    def __init__(self):
        # Load config
        with open('config.yaml', 'r') as f:
            self.config = yaml.safe_load(f)
        
        # Using SODA API endpoint
        self.base_url = "https://data.cityofchicago.org/resource/bbyy-e7gq.csv"
        self.page_size = self.config['api']['page_size']
        self.max_retries = self.config['api']['max_retries']
    
    def get_stations(self):
        """
        Fetch all Divvy stations from the Chicago Data Portal with pagination support
        """
        all_stations = []
        offset = 0
        retry_count = 0
        headers = None
        
        while True:
            try:
                # Fetch page of stations
                response = requests.get(
                    self.base_url,
                    params={
                        "$offset": offset,
                        "$limit": self.page_size
                    },
                    timeout=self.config['api']['timeouts']['soda']
                )
                response.raise_for_status()
                
                # Split CSV into lines
                lines = response.text.strip().split('\n')
                if len(lines) <= 1:  # Only header or empty response
                    break
                
                # Get headers from first page only
                if headers is None:
                    headers = [h.strip('"') for h in lines[0].split(',')]
                    
                # Process each line in the page
                for line in lines[1:]:
                    try:
                        # Parse CSV line, handling quoted values
                        values = []
                        in_quote = False
                        current_value = ''
                        
                        for char in line:
                            if char == '"':
                                in_quote = not in_quote
                            elif char == ',' and not in_quote:
                                values.append(current_value.strip('"'))
                                current_value = ''
                            else:
                                current_value += char
                        values.append(current_value.strip('"'))
                        
                        station = dict(zip(headers, values))
                        
                        station_data = {
                            'id': station['id'],
                            'station_name': station['station_name'].strip(),
                            'short_name': station['short_name'],
                            'total_docks': int(station['total_docks']),
                            'docks_in_service': int(station['docks_in_service']),
                            'status': station['status'],
                            'latitude': float(station['latitude']),
                            'longitude': float(station['longitude']),
                            'is_electric': station['station_name'].endswith('*'),
                            'last_updated': datetime.utcnow()
                        }
                        all_stations.append(station_data)
                    except (ValueError, TypeError, KeyError) as e:
                        logger.debug(f"Error parsing station: {e}")
                        continue
                
                # Reset retry count on successful processing
                retry_count = 0
                
                # Move to next page
                records_in_page = len(lines) - 1  # Subtract header row
                if records_in_page < self.page_size:
                    break
                
                offset += records_in_page
                logger.info(f"Fetched {len(all_stations)} stations so far")
                
            except requests.exceptions.RequestException as e:
                retry_count += 1
                if retry_count > self.max_retries:
                    logger.error(f"Max retries exceeded at offset {offset}: {e}")
                    break
                logger.warning(f"Retry {retry_count}/{self.max_retries} at offset {offset}: {e}")
                time.sleep(2 ** retry_count)  # Exponential backoff
        
        logger.info(f"Successfully processed {len(all_stations)} total stations")
        return all_stations
