from atproto import Client
import os
from dotenv import load_dotenv
import logging

logger = logging.getLogger(__name__)

class BlueskyPoster:
    def __init__(self, test_mode=False):
        self.test_mode = test_mode
        
        if not test_mode:
            load_dotenv()
            self.handle = os.getenv('BLUESKY_HANDLE')
            self.password = os.getenv('BLUESKY_APP_PASSWORD')
            
            if not self.handle or not self.password:
                raise ValueError("Bluesky credentials not found in environment variables")
            
            self.client = Client()
            self.client.login(self.handle, self.password)
    
    def post_new_station(self, station, map_path):
        """Post about a new Divvy station"""
        text = f"🆕 New Divvy Station Alert!\n\n"
        text += f"📍 {station.station_name}\n"
        text += f"🚲 {station.total_docks} docks\n"
        text += f"⚡ {'Electric bikes available!' if station.is_electric else 'Standard bikes only'}\n"
        
        self._create_post(text, map_path)
    
    def post_electrified_station(self, station, map_path):
        """Post about a station being electrified"""
        text = f"⚡ Divvy Station Electrified!\n\n"
        text += f"📍 {station.station_name}\n"
        text += f"🚲 {station.total_docks} docks\n"
        text += "Now supporting electric bikes! 🔌"
        
        self._create_post(text, map_path)
    
    def _create_post(self, text, image_path):
        """Helper method to create a post with an image"""
        try:
            if self.test_mode:
                # Preview the post
                preview = "\n=== POST PREVIEW ===\n"
                preview += f"Text:\n{text}\n"
                preview += f"Image: {image_path}\n"
                preview += "==================="
                logger.info(preview)
            else:
                # Upload the image
                with open(image_path, 'rb') as f:
                    upload = self.client.com.atproto.repo.upload_blob(f)
                
                # Create the post with the image
                self.client.com.atproto.repo.create_record(
                    repo=self.client.me.did,
                    collection='app.bsky.feed.post',
                    record={
                        'text': text,
                        'embed': {
                            '$type': 'app.bsky.embed.images',
                            'images': [{
                                'alt': 'Map showing the location of the Divvy station',
                                'image': upload.blob
                            }]
                        },
                        'createdAt': None  # Will be set by the server
                    }
                )
                logger.info(f"Successfully posted to Bluesky: {text[:50]}...")
            
        except Exception as e:
            logger.error(f"Error posting to Bluesky: {e}")
            raise
