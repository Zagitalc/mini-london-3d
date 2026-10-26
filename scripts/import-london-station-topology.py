#!/usr/bin/env python3
"""Normalize one TfL Stop Structure XML response into a compact JSON snapshot."""

import argparse
import gzip
import json
import math
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path, help='TfL Stop Structure XML response')
    parser.add_argument('output', type=Path, help='Output JSON or .json.gz path')
    parser.add_argument('--station-id', required=True, help='ATCO station code, e.g. 940GZZLUBST')
    return parser.parse_args()


def parse_number(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def parse_point(point):
    return {
        'areaId': point.get('area'),
        'stopId': point.get('stopID'),
        'longitude': parse_number(point.get('x')),
        'latitude': parse_number(point.get('y')),
        'level': parse_number(point.get('level')),
        'geoRef': point.get('georef') or None
    }


def normalize(source, station_id):
    xml = source[source.find('<itdRequest'):]
    if not xml:
        raise ValueError('No <itdRequest> element found in input')
    # Browser-copied XML can contain bare ampersands in route descriptions.
    xml = re.sub(r'&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9A-Fa-f]+;)', '&amp;', xml)
    xml = ''.join(char for char in xml if char in '\t\n\r' or ord(char) >= 32)
    root = ET.fromstring(xml)
    structure = root.find('.//stopStructure')
    if structure is None:
        raise ValueError('Response has no stopStructure')

    areas = []
    area_ids = set()
    for block in structure.findall('.//stopAreaLines'):
        area = block.find('./stopArea')
        point = area.find('./itdPoint') if area is not None else None
        if area is None or point is None:
            continue
        if point.get('gid') != station_id:
            continue
        area_id = point.get('area')
        if area_id in area_ids:
            continue
        area_ids.add(area_id)
        serving_lines = []
        for line in block.findall('./itdServingLines/itdServingLine'):
            serving_lines.append({
                'symbol': line.get('symbol') or '',
                'mode': line.get('motType') or '',
                'name': line.findtext('./itdRouteDescText', default='').strip()
            })
        areas.append({
            'id': area_id,
            'name': area.get('areaName') or '',
            'level': parse_number(area.get('level')),
            'type': int(area.get('areaType') or 0),
            'nameAtStop': area.get('stopName') or '',
            'point': parse_point(point),
            'lines': serving_lines
        })

    if not areas:
        raise ValueError(f'No station areas found for {station_id}')

    paths = []
    for path in structure.findall('.//footpathInfos/footpathInfo'):
        points = path.findall('./itdPoint')
        if len(points) < 2 or points[0].get('gid') != station_id or points[1].get('gid') != station_id:
            continue
        parts = []
        for part in path.findall('./footpathPartInfos/footpathPartInfo'):
            part_points = [parse_point(point) for point in part.findall('./itdPoint')]
            parts.append({'type': part.get('type') or 'LEVEL', 'points': part_points})
        paths.append({
            'from': points[0].get('area'),
            'to': points[1].get('area'),
            'duration': parse_number(path.get('duration')),
            'distance': parse_number(path.get('distance')),
            'parts': parts
        })

    if not paths:
        raise ValueError(f'No footpaths found for {station_id}')

    return {
        'source': 'TfL Stop Structure API',
        'attribution': 'Data provided by Transport for London',
        'stationId': station_id,
        'stationName': areas[0]['nameAtStop'],
        'generatedAt': root.get('now'),
        'dataBuild': root.findtext('.//dataBuild'),
        'areas': areas,
        'paths': paths
    }


def main():
    args = parse_args()
    data = normalize(args.input.read_text(encoding='utf-8'), args.station_id)
    encoded = json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.output.suffix == '.gz':
        with args.output.open('wb') as output:
            with gzip.GzipFile(fileobj=output, mode='wb', mtime=0) as stream:
                stream.write(encoded)
    else:
        args.output.write_bytes(encoded)
    print(f"{data['stationName']}: {len(data['areas'])} areas, {len(data['paths'])} paths")


if __name__ == '__main__':
    try:
        main()
    except (ET.ParseError, OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
