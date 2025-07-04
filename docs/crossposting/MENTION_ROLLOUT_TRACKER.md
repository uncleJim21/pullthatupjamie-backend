# Cross-Platform Mention Mapping: Rollout & Progress Tracker

## 🚦 Rollout Plan & Progress

| Step | Feature/Task | Status | Notes |
|------|--------------|--------|-------|
| 1    | **Schema foundation**: Add/extend User.mention_preferences, create SocialProfileMappings, define all IDs | ✅ Completed | User & SocialProfileMappings models updated |
| 2    | **Upgrade lookup**: Implement `/api/mentions/search` with new schema, unified results | ✅ Completed | Twitter, cross-mapping, and placeholder logic implemented |
| 3    | Personal pin management: `/api/mentions/pins` CRUD | ✅ Completed | Authentication middleware, GET, POST, PUT, DELETE operations implemented |
| 4    | Cross-platform mapping adoption: `/api/mentions/adopt-cross-mapping` | ⬜️ Not started |  |
| 5    | Public mapping discovery, voting, reporting | ⬜️ Not started |  |
| 6    | Mapping creation & management | ⬜️ Not started |  |
| 7    | Performance/caching | ⬜️ Not started |  |

---

## Immediate Next Steps

### 1. Schema Foundation
- [x] Extend `User` model: add `mention_preferences` (array of pins/adopted mappings)
- [x] Create `SocialProfileMappings` model
- [x] Define all identifier conventions (`pinId`, `mappingId`, `mapping_key`, etc.)

### 2. Upgrade Lookup Endpoint
- [x] Scaffold `/api/mentions/search` route
- [x] Implement search logic (Twitter API, mappings, pins)
- [x] Return unified results (Twitter, Nostr, cross-mapping info)
- [x] Return user's personal pins in results (placeholder for now)

---

## File Moves
- [x] Move `MENTION-SEARCH-API.md` → `docs/crossposting/MENTION-SEARCH-API.md`
- [x] Move `MENTION_MAPPING_LIFECYCLE.md` → `docs/crossposting/MENTION_MAPPING_LIFECYCLE.md`
- [x] Save this tracker as `docs/crossposting/MENTION_ROLLOUT_TRACKER.md`

---

**/api/mentions/search is now live for Twitter and cross-mapping MVP. Ready for next features or testing!** 