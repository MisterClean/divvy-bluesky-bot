"""Module for fetching property images from Google Street View."""
import os
from datetime import datetime
from pathlib import Path
import logging
import requests
import yaml
from dotenv import load_dotenv

logger = logging.getLogger(__name__)

class StreetViewError(Exception):
    """Custom exception for street view image fetching errors."""
    pass

class StreetViewFetcher:
    def __init__(self):
        """Initialize the street view fetcher with API key."""
        load_dotenv()
        self.api_key = os.getenv('GOOGLE_MAPS_API_KEY')
        if not self.api_key:
            raise StreetViewError("GOOGLE_MAPS_API_KEY environment variable not found")
        
        # Ensure images directory exists
        self.images_dir = Path("output/streetview")
        self.images_dir.mkdir(parents=True, exist_ok=True)
        
    def get_street_view_image(self, lat: float, lon: float, station_name: str) -> str:
        """
        Fetches a Street View image for given coordinates using Google Street View Static API
        
        Args:
            lat: Latitude coordinate
            lon: Longitude coordinate
            station_name: Station name for filename
            
        Returns:
            Path to saved image file
            
        Raises:
            StreetViewError: If image fetch fails
        """
        try:
            base_url = "https://maps.googleapis.com/maps/api/streetview"
            params = {
                'size': '600x400',  # Image size
                'location': f'{lat},{lon}',
                'key': self.api_key,
                'return_error_code': True
            }
            
            # Load config
            with open('config.yaml', 'r') as f:
                config = yaml.safe_load(f)
            
            response = requests.get(f"{base_url}", params=params, timeout=config['api']['timeouts']['streetview'])
            
            if response.status_code == 200:
                # Create filename from sanitized station name
                safe_name = "".join(x for x in station_name if x.isalnum() or x in (' ', '-', '_'))
                filename = self.images_dir / f"{safe_name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.jpg"
                
                with open(filename, 'wb') as f:
                    f.write(response.content)
                return str(filename)
            else:
                raise StreetViewError(f"Failed to fetch Street View image: {response.status_code}")
                
        except Exception as e:
            raise StreetViewError(f"Error fetching Street View image: {str(e)}")
