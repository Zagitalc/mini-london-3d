#!/usr/bin/env python3
"""Build Baker Street's bundled street map from an OpenStreetMap API XML export.

Download once from https://api.openstreetmap.org/api/0.6/map with bbox
-0.1596,51.5213,-0.1549,51.5244, then pass the saved .osm file and output .json.gz.
This is an offline import; application builds and visitors do not query OSM.
"""

import argparse
import gzip
import json
import xml.etree.ElementTree as ET
from pathlib import Path


def normalize(root):
    nodes = {
        node.get('id'): [round(float(node.get('lon')), 6), round(float(node.get('lat')), 6)]
        for node in root.findall('node')
    }
    features = []
    for way in root.findall('way'):
        tags = {tag.get('k'): tag.get('v') for tag in way.findall('tag')}
        highway = tags.get('highway')
        if tags.get('building') and tags['building'] != 'no':
            kind = 'building'
        elif tags.get('leisure') == 'park' or tags.get('landuse') in ('grass', 'recreation_ground'):
            kind = 'park'
        elif highway and tags.get('indoor') != 'yes' and tags.get('tunnel') != 'yes':
            kind = 'footway' if highway in ('footway', 'path', 'steps', 'cycleway', 'pedestrian') else 'road'
        else:
            continue
        coordinates = [nodes[node.get('ref')] for node in way.findall('nd') if node.get('ref') in nodes]
        if len(coordinates) < 2:
            continue
        features.append({
            'id': way.get('id'), 'kind': kind, 'roadClass': highway,
            'name': tags.get('name', ''), 'coordinates': coordinates
        })
    if not any(feature['kind'] == 'road' and feature['name'] == 'Marylebone Road' for feature in features):
        raise ValueError('OSM export must cover the streets around Baker Street')
    return {
        'stationId': '940GZZLUBST',
        'source': 'OpenStreetMap contributors',
        'sourceUrl': 'https://www.openstreetmap.org/copyright',
        'license': 'ODbL 1.0',
        'bounds': [-0.1592, 51.52165, -0.1551, 51.5241],
        'features': sorted(features, key=lambda feature: int(feature['id']))
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    data = normalize(ET.parse(args.input).getroot())
    encoded = json.dumps(data, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    # No embedded filename or timestamp: identical source yields identical bytes.
    with args.output.open('wb') as output:
        with gzip.GzipFile(filename='', fileobj=output, mode='wb', mtime=0) as stream:
            stream.write(encoded)
    print(f"Baker Street street map: {len(data['features'])} features")


if __name__ == '__main__':
    main()
