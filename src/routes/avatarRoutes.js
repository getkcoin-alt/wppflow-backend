import express from "express";
import { route } from "../middleware/http.js";
import { avatarRateLimiter } from "../middleware/rateLimiter.js";
import { KINDS, LATER, pictureFor, signatureMatches, targetOf } from "../services/avatarService.js";

// A profile picture, for an <img> tag. There is no sign-in on this route, because the browser cannot add one to an image:
// the address carries a signature that names the chat and the company (see avatarService.avatarUrl). A wrong or missing
// signature is answered exactly like a chat that does not exist, so nothing can be probed.
const router = express.Router();
router.use(avatarRateLimiter);

const none = (res) => {
  res.set("Cache-Control", "private, max-age=300");
  res.status(404).end();
};

router.get(
  "/:kind/:id",
  route(async (req, res) => {
    const { kind, id } = req.params;
    if (!KINDS.includes(kind) || !/^[\w-]{1,64}$/.test(id) || typeof req.query.s !== "string") return none(res);
    const target = await targetOf(kind, id);
    if (!target || !signatureMatches(kind, target.tenantId, id, req.query.s)) return none(res);
    const picture = await pictureFor(target);
    if (picture === LATER) {
      // WhatsApp could not be asked just now: the browser may look again soon
      res.set("Cache-Control", "private, max-age=30");
      return res.status(404).end();
    }
    if (!picture) return none(res);
    const etag = `"${picture.fetchedAt.getTime().toString(36)}-${picture.bytes.length.toString(36)}"`;
    res.set({
      "Content-Type": picture.type,
      // the address is a permission, so only the person's own browser may keep the picture
      "Cache-Control": "private, max-age=3600",
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
      // the app may be served from another address than the API (a preview, a developer machine)
      "Cross-Origin-Resource-Policy": "cross-origin",
    });
    // Express answers "unchanged" (304) by itself when the browser sends back the ETag
    res.send(picture.bytes);
  }),
);
export default router;
