from sqlalchemy import create_engine, Column, Integer, String, Float, Boolean, DateTime
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
import os
from dotenv import load_dotenv
from datetime import datetime

load_dotenv()

Base = declarative_base()

class Station(Base):
    __tablename__ = 'stations'
    
    id = Column(String, primary_key=True)
    station_name = Column(String)
    short_name = Column(String)
    total_docks = Column(Integer)
    docks_in_service = Column(Integer)
    status = Column(String)
    latitude = Column(Float)
    longitude = Column(Float)
    is_electric = Column(Boolean, default=False)
    last_updated = Column(DateTime, default=datetime.utcnow)

    def __repr__(self):
        return f"<Station(name='{self.station_name}', docks={self.total_docks}, electric={self.is_electric})>"

class Database:
    def __init__(self):
        db_path = os.getenv('DB_PATH', 'data/divvy_stations.db')
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        self.engine = create_engine(f'sqlite:///{db_path}')
        Base.metadata.create_all(self.engine)
        Session = sessionmaker(bind=self.engine)
        self.session = Session()

    def get_station(self, station_id):
        return self.session.query(Station).filter_by(id=station_id).first()

    def get_all_stations(self):
        return self.session.query(Station).all()

    def add_or_update_station(self, station_data):
        station = self.get_station(station_data['id'])
        if station is None:
            station = Station(**station_data)
            self.session.add(station)
            is_new = True
        else:
            # Check if station was electrified
            was_electrified = not station.is_electric and station_data.get('is_electric', False)
            
            # Update station data
            for key, value in station_data.items():
                setattr(station, key, value)
            
            is_new = False
            if was_electrified:
                return 'electrified'
        
        self.session.commit()
        return 'new' if is_new else None

    def close(self):
        self.session.close()
