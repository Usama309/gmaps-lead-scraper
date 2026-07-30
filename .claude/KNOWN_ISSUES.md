# Known Issues

## Open
- Google review dates are relative text only, so last-review precision beyond roughly
  four weeks is approximate. Documented in the spec, not fixable.
- Mobile-friendliness is a heuristic from a single HTML fetch, not a PageSpeed verdict.
  Labelled as such in the UI.
- The sub-940px dashboard layout has never been rendered and verified. The CSS exists.
- The `np:` fallback dedupe key can merge two distinct locations. Two branches of a
  same-named business that share a central switchboard number produce an identical
  name plus phone key, so one location is silently lost. Only affects records where
  Google supplied no CID, which is the degraded-data path rather than the normal one.

## Resolved
None yet.
