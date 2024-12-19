from atproto import Client
import os
from dotenv import load_dotenv
import logging
from datetime import datetime
import yaml
from streetview import StreetViewFetcher

logger = logging.getLogger(__name__)

class BlueskyPoster:
    def __init__(self, test_mode=False):
        self.test_mode = test_mode
        
        # Load config
        with open('config.yaml', 'r') as f:
            self.config = yaml.safe_load(f)
        
        # Initialize streetview fetcher if enabled
        self.streetview_enabled = self.config['features'].get('streetview_images', False)
        self.streetview = StreetViewFetcher() if self.streetview_enabled else None
        
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
        # First post with map
        text = f"🆕 New Divvy Station Alert!\n\n"
        text += f"📍 {station.station_name}\n"
        text += f"🚲 {station.total_docks} docks\n"
        text += f"⚡️ Station is electrified!\n" if station.is_electric else ""
        
        # Create first post and get its URI
        post_uri = self._create_post(text, map_path)
        
        # If streetview is enabled, create a second post with the streetview image
        if self.streetview_enabled:
            try:
                streetview_path = self.streetview.get_street_view_image(
                    station.latitude,
                    station.longitude,
                    station.station_name
                )
                text = f"📸 Street view of {station.station_name}"
                self._create_post(text, streetview_path, reply_to=post_uri)
            except Exception as e:
                logger.error(f"Failed to create streetview post: {e}")
    
    def post_electrified_station(self, station, map_path):
        """Post about a station being electrified"""
        text = f"⚡ Divvy Station Electrified!\n\n"
        text += f"📍 {station.station_name}\n"
        text += f"🚲 {station.total_docks} docks\n"
        text += "Now supporting electric bikes! 🔌"
        
        self._create_post(text, map_path)
    
    def _create_post(self, text, image_path, reply_to=None):
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
                record = {
                    'text': text,
                    'embed': {
                        '$type': 'app.bsky.embed.images',
                        'images': [{
                            'alt': 'Map showing the location of the Divvy station',
                            'image': upload.blob
                        }]
                    },
                    'createdAt': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.%fZ')
                }
                
                # Add reply if this is part of a thread
                if reply_to:
                    # Get the post details to get the CID
                    post_details = self.client.app.bsky.feed.get_post_thread({'uri': reply_to})
                    thread_post = post_details.thread.post
                    record['reply'] = {
                        'root': {
                            'uri': reply_to,
                            'cid': thread_post.cid
                        },
                        'parent': {
                            'uri': reply_to,
                            'cid': thread_post.cid
                        }
                    }
                
                data = {
                    'repo': self.client.me.did,
                    'collection': 'app.bsky.feed.post',
                    'record': record
                }
                response = self.client.com.atproto.repo.create_record(data=data)
                logger.info(f"Successfully posted to Bluesky: {text[:50]}...")
                
                # Return the post URI for threading
                return f"at://{self.client.me.did}/app.bsky.feed.post/{response.uri.split('/')[-1]}"
            
        except Exception as e:
            logger.error(f"Error posting to Bluesky: {e}")
            raise
