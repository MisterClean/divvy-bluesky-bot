import os
import time
import geopandas as gpd
import contextily as ctx
import matplotlib.pyplot as plt
from shapely.geometry import Point
import numpy as np
import folium
from PIL import Image

class MapGenerator:
    def __init__(self):
        # Create output directories if they don't exist
        self.output_dir = "output/maps"
        os.makedirs(self.output_dir, exist_ok=True)
        
    def generate_station_map(self, station):
        """
        Generate both static and interactive maps centered on a station with a 2-block buffer
        A typical Chicago city block is about 100 meters
        2 blocks = 200 meters
        
        Returns:
            tuple: (static_map_path, interactive_map_path)
        """
        # Create point geometry for the station
        station_point = Point(station.longitude, station.latitude)
        station_gdf = gpd.GeoDataFrame(
            {'name': [station.id]},
            geometry=[station_point],
            crs="EPSG:4326"
        )
        
        # Convert to local projected CRS for accurate buffer
        local_crs = f"+proj=tmerc +lat_0={station.latitude} +lon_0={station.longitude} +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs"
        station_proj = station_gdf.to_crs(local_crs)
        
        # Generate static map
        fig, ax = plt.subplots(figsize=(6, 6))
        
        # Convert to Web Mercator for static map
        station_gdf_web_merc = station_gdf.to_crs(epsg=3857)
        
        # Set map extent based on station with fixed zoom
        bounds = station_gdf_web_merc.total_bounds
        center_x = (bounds[0] + bounds[2]) / 2
        center_y = (bounds[1] + bounds[3]) / 2
        width = 400  # meters
        bounds = [
            center_x - width,
            center_y - width,
            center_x + width,
            center_y + width
        ]
        ax.set_xlim(bounds[0], bounds[2])
        ax.set_ylim(bounds[1], bounds[3])
        
        # Add modern basemap with muted colors
        ctx.add_basemap(
            ax,
            source=ctx.providers.CartoDB.Positron,
            alpha=0.9  # Slightly less fade for clarity
        )
        
        # Plot station with a simple circle marker
        station_color = '#E53935' if station.is_electric else '#1E88E5'  # Material Design colors
        ax.plot(station_gdf_web_merc.geometry.x, station_gdf_web_merc.geometry.y, 
                marker='o', markersize=12, color=station_color,
                markeredgewidth=0, alpha=0.9)
        
        # Remove axes
        ax.set_axis_off()
        
        # Save static map
        static_filename = f"{station.id}_{int(time.time())}_static.png"
        static_filepath = os.path.join(self.output_dir, static_filename)
        # Save initial map
        plt.savefig(static_filepath, bbox_inches='tight', dpi=300, pad_inches=0)
        plt.close()
        
        # Optimize the PNG file size
        with Image.open(static_filepath) as img:
            img.save(static_filepath, 'PNG', optimize=True, quality=85)
        
        # Create interactive Folium map with modern style
        m = folium.Map(
            location=[station.latitude, station.longitude],
            zoom_start=16,
            tiles='CartoDB Positron',  # Clean, modern map style
            control_scale=True
        )
        
        # Add station marker with pin icon
        station_color = 'red' if station.is_electric else 'blue'
        folium.Marker(
            location=[station.latitude, station.longitude],
            popup=f"Station {station.id}",
            icon=folium.DivIcon(
                html=f'<div style="font-size: 24px;">📍</div>',
                icon_size=(24, 24),
                icon_anchor=(12, 24)
            )
        ).add_to(m)
        
        
        # Save interactive map
        interactive_filename = f"{station.id}_{int(time.time())}_interactive.html"
        interactive_filepath = os.path.join(self.output_dir, interactive_filename)
        m.save(interactive_filepath)
        
        return static_filepath, interactive_filepath
