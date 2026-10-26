# Baker Street carriage-guidance data audit

Research date: 26 October 2026. This is a candidate-data review, not published
carriage advice. The application and deployed recommendations are unchanged.

**Decision:** the user requires current verification before any recommendation is
displayed. Dated or crowd-verified marketing descriptions alone do not meet that
requirement. None of the records below is approved for runtime use.

## What the current graph can support

The bundled TfL Stop Structure snapshot contains area IDs, names, serving lines,
coordinates, level codes, directed footpaths, durations and movement parts. It
contains no carriage number, door number, longitudinal platform position, or
train stopping-reference field. A point on the map is not enough to infer where
along a stopped train a passenger should stand. Existing route calculations
therefore cannot produce a best carriage from this snapshot alone.

## Located sources

[MindSpace / Describe Online: Find an Exit from a Baker Street Platform](https://mindspace.fi/mind/findexitfromplatform-bakerstreet/)
was published on **14 December 2021**. Its publication date is known; the date of
the underlying station survey and any subsequent field check were not established.
Its exit descriptions contain these candidate observations:

| Platform | Line / direction | Published position | Destination scope |
|---|---|---|---|
| 7 | Jubilee southbound | Front | Access towards exit escalators |
| 8 | Bakerloo southbound | Front | Access towards exit escalators |
| 9 | Bakerloo northbound | Third carriage from front | Access towards exit escalators |
| 10 | Jubilee northbound | Middle | Access towards exit escalators |

These observations are paraphrased source records, **not currently verified
recommendations**. They concern the described route towards Baker Street exits.
They must not be attached to every platform-to-platform transfer: a cross-passage
or stairs transfer can use a different point along the platform. The exact
mapping of the described exits to TfL's A-M-N/B-M-S/C-BAK/D-M-C codes is unresolved.
Do not turn the platform 9 record into a precise modern door recommendation or
silently replace its specific position with a generic “middle” classification.

[The reverse entrance-to-platform description](https://mindspace.fi/mind/retro/lul/bakerstreet/findplatformfromentrance.html)
contains broad front/middle locations too. Agreement between related pages from
the same guide is not independent confirmation or evidence of a recent survey.

[First Out](https://firstout.app/) describes its exit positions as crowd-verified.
Individual Baker Street verification dates, supporting observations and an
established data-reuse arrangement were not obtained in this audit. Its marketing
claim is not a substitute for checking a candidate recommendation.

The [2026 AccessAble station survey](https://www.accessable.co.uk/baker-street-and-marylebone-area/access-guides/baker-street-station)
is useful for entrances and platform access, but the available text did not
establish carriage positions for the four proposed pilot cases.

## Smallest verification pilot

Check one destination-specific exit or interchange on each of platforms 7–10.
For every record, capture:

- station, line, direction and physical platform number;
- the named destination and its mapping to the app's destination ID;
- position relative to the **front of the arriving train**, with front/middle/rear
  kept distinct from exact carriage and door numbering;
- the passage, stairs or escalator used, and the first route connection it matches;
- observation date, source/evidence reference, and verification status.

Train orientation and stopping position matter. An entrance's geographic position
or an estimated walking time does not establish either. Exact door numbers need
additional checked rolling-stock and stopping-position information.

Until a current check is available, keep candidates separate from trusted runtime
recommendations. The user chose to exclude the dated guide from runtime recommendations. No
current recommendation or new browser API polling was added by this audit.

The four blank records in `baker-street-carriage-verification.csv` are a collection
template, not application data. Fill in a specific destination and its verified
TfL area mapping, the observed train-relative position, and dated evidence before
promoting a row. Blank positions must remain unknown. A source publication date
must never be substituted for a field-verification date.
