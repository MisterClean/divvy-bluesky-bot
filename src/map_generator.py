import folium
import os
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from tempfile import NamedTemporaryFile
import time

class MapGenerator:
    def __init__(self):
        # Create output directory if it doesn't exist
        self.output_dir = "output/maps"
        os.makedirs(self.output_dir, exist_ok=True)
        
        # Configure Chrome options for headless screenshot capture
        self.chrome_options = Options()
        self.chrome_options.add_argument("--headless")
        self.chrome_options.add_argument("--no-sandbox")
        self.chrome_options.add_argument("--disable-dev-shm-usage")
        
    def generate_station_map(self, station):
        """
        Generate a map centered on a station with a 4-block buffer
        A typical Chicago city block is about 100 meters
        4 blocks = 400 meters = 0.004 degrees (approximate at Chicago's latitude)
        """
        # Create the map centered on the station
        m = folium.Map(
            location=[station.latitude, station.longitude],
            zoom_start=16,
            width=800,
            height=600
        )
        
        # Add the station marker
        folium.Marker(
            [station.latitude, station.longitude],
            popup=f"{station.station_name}<br>Total Docks: {station.total_docks}<br>{'Electric' if station.is_electric else 'Standard'} Station",
            icon=folium.Icon(color='red' if station.is_electric else 'blue')
        ).add_to(m)
        
        # Add a circle to show the 4-block radius (approximately 400 meters)
        folium.Circle(
            [station.latitude, station.longitude],
            radius=400,
            color="gray",
            fill=True,
            opacity=0.2
        ).add_to(m)
        
        # Save map to a temporary HTML file
        with NamedTemporaryFile(suffix='.html', delete=False) as tmp:
            m.save(tmp.name)
            
            # Use Selenium to capture the map as an image
            driver = webdriver.Chrome(options=self.chrome_options)
            driver.get(f'file://{tmp.name}')
            time.sleep(2)  # Wait for map to fully render
            
            # Generate unique filename
            filename = f"{station.id}_{int(time.time())}.png"
            filepath = os.path.join(self.output_dir, filename)
            
            # Take screenshot and save
            driver.save_screenshot(filepath)
            driver.quit()
            
            # Clean up temporary file
            os.unlink(tmp.name)
            
            return filepath
