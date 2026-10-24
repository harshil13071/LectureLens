import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { createHmac, randomBytes, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { getPool } from "@workspace/db";

const router: IRouter = Router();
let schemaReady: Promise<void> | undefined;
const limiter = new Map<string, { count: number; reset: number }>();
const secret = () => process.env.ROOM_SESSION_SECRET || process.env.SESSION_SECRET;

function db() {
  if (!process.env.DATABASE_URL) throw Object.assign(new Error("Study rooms require DATABASE_URL."), { status: 503 });
  const pool=getPool();
  schemaReady ??= pool.query(`
    CREATE TABLE IF NOT EXISTS study_rooms (
      id uuid PRIMARY KEY, name varchar(80) NOT NULL, description varchar(500) NOT NULL DEFAULT '', subject varchar(80) NOT NULL,
      owner_id uuid NOT NULL, invite_hash char(64) NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS study_room_members (
      room_id uuid NOT NULL REFERENCES study_rooms(id) ON DELETE CASCADE, user_id uuid NOT NULL, display_name varchar(40) NOT NULL,
      role varchar(10) NOT NULL CHECK(role IN ('owner','member')), joined_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(room_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS study_room_materials (
      id uuid PRIMARY KEY, room_id uuid NOT NULL REFERENCES study_rooms(id) ON DELETE CASCADE, created_by uuid NOT NULL,
      creator_name varchar(40) NOT NULL, kind varchar(20) NOT NULL CHECK(kind IN ('note','flashcards','mindmap','quiz')),
      title varchar(120) NOT NULL, content jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS study_room_members_user_idx ON study_room_members(user_id);
    CREATE INDEX IF NOT EXISTS study_room_materials_room_idx ON study_room_materials(room_id,created_at DESC);
  `).then(() => undefined);
  return pool;
}

function signed(id: string): string { return createHmac("sha256", secret()!).update(id).digest("base64url"); }
function sessionId(req: Request): string | undefined {
  const raw = req.cookies?.ll_room_session;
  if (!raw || !secret()) return undefined;
  const [id, mac] = String(raw).split(".");
  if (!id || !mac) return undefined;
  const expected = Buffer.from(signed(id));
  const actual = Buffer.from(mac);
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? id : undefined;
}
function limited(req: Request, res: Response, next: NextFunction): void {
  const key = `${req.ip}:${req.path}`; const now = Date.now();
  const limit = req.path === "/rooms" && req.method === "POST" ? 10
    : req.path === "/rooms/session" || req.path === "/rooms" ? 120
    : req.path.endsWith("/materials") ? 30 : 20;
  if (limiter.size > 5000) for (const [entry, bucket] of limiter) if (bucket.reset < now) limiter.delete(entry);
  const state = limiter.get(key);
  if (!state || state.reset < now) limiter.set(key, { count: 1, reset: now + 60_000 });
  else if (state.count >= limit) { res.status(429).json({ error: "Too many room requests. Try again in a minute." }); return; }
  else state.count++;
  next();
}
router.use(limited);
router.use(async (_req, _res, next) => { try { await (db(), schemaReady); next(); } catch (e) { schemaReady = undefined; next(e); } });
function requireSession(req: Request, res: Response): string | undefined {
  const id = sessionId(req); if (!id) res.status(401).json({ error: "Set a guest name to continue." }); return id;
}
async function membership(roomId: string, userId: string) {
  const result = await db().query("SELECT role,display_name FROM study_room_members WHERE room_id=$1 AND user_id=$2", [roomId,userId]);
  return result.rows[0] as { role: string; display_name: string } | undefined;
}
const validId = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const text = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.trim().length <= max ? value.trim() : undefined;

router.post("/rooms/session", (req,res) => {
  const displayName = text(req.body?.displayName,40);
  if (!displayName) { res.status(400).json({error:"Enter a name of up to 40 characters."}); return; }
  if (!secret() || secret()!.length < 32) { res.status(503).json({error:"Study rooms are not configured. Set ROOM_SESSION_SECRET (at least 32 characters)."}); return; }
  const id = sessionId(req) || randomUUID();
  res.cookie("ll_room_session", `${id}.${signed(id)}`, { httpOnly:true, secure:process.env.NODE_ENV === "production", sameSite:"lax", maxAge: 1000*60*60*24*180, path:"/" });
  res.json({displayName});
});

router.get("/rooms", async (req,res,next) => { try {
  const user = requireSession(req,res); if (!user) return;
  const rows = await db().query(`SELECT r.id,r.name,r.description,r.subject,r.owner_id AS "ownerId",r.updated_at AS "updatedAt",m.role,
    (SELECT count(*)::int FROM study_room_members x WHERE x.room_id=r.id) AS "memberCount",
    (SELECT count(*)::int FROM study_room_materials x WHERE x.room_id=r.id) AS "materialCount"
    FROM study_rooms r JOIN study_room_members m ON m.room_id=r.id WHERE m.user_id=$1 ORDER BY r.updated_at DESC`,[user]);
  res.json({rooms:rows.rows});
} catch(e){next(e);} });

router.post("/rooms", async (req,res,next) => { try {
  const user=requireSession(req,res); if(!user)return;
  const name=text(req.body?.name,80), subject=text(req.body?.subject,80), description=typeof req.body?.description === "string" ? req.body.description.trim().slice(0,500) : "";
  const displayName=text(req.body?.displayName,40);
  if(!name||!subject||!displayName){res.status(400).json({error:"Room name, subject, and guest name are required."});return;}
  const id=randomUUID(), invite=randomBytes(32).toString("base64url"), hash=createHash("sha256").update(invite).digest("hex");
  const client=await db().connect(); try { await client.query("BEGIN");
    await client.query("INSERT INTO study_rooms(id,name,description,subject,owner_id,invite_hash) VALUES($1,$2,$3,$4,$5,$6)",[id,name,description,subject,user,hash]);
    await client.query("INSERT INTO study_room_members(room_id,user_id,display_name,role) VALUES($1,$2,$3,'owner')",[id,user,displayName]); await client.query("COMMIT");
  } catch(e){await client.query("ROLLBACK");throw e;} finally {client.release();}
  res.status(201).json({room:{id,name,description,subject,role:"owner",ownerId:user,memberCount:1,materialCount:0,updatedAt:new Date().toISOString()},inviteToken:invite});
}catch(e){next(e);} });

router.post("/rooms/join", async (req,res,next)=>{try{
  const user=requireSession(req,res);if(!user)return;
  const token=text(req.body?.inviteToken,100),displayName=text(req.body?.displayName,40);
  if(!token||!displayName){res.status(400).json({error:"Invitation and guest name are required."});return;}
  const hash=createHash("sha256").update(token).digest("hex");
  const client=await db().connect();try{await client.query("BEGIN");
    const found=await client.query("SELECT id,name FROM study_rooms WHERE invite_hash=$1 FOR UPDATE",[hash]);
    if(!found.rowCount){await client.query("ROLLBACK");res.status(404).json({error:"This invitation is invalid or has been revoked."});return;}
    const room=found.rows[0];
    await client.query(`INSERT INTO study_room_members(room_id,user_id,display_name,role) VALUES($1,$2,$3,'member') ON CONFLICT(room_id,user_id) DO UPDATE SET display_name=EXCLUDED.display_name`,[room.id,user,displayName]);
    await client.query("COMMIT");res.json({roomId:room.id,name:room.name});
  }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
}catch(e){next(e);} });

router.get("/rooms/:id", async(req,res,next)=>{try{
  const user=requireSession(req,res);if(!user)return; if(!validId(req.params.id)){res.status(400).json({error:"Invalid room ID."});return;}
  const member=await membership(req.params.id,user);if(!member){res.status(403).json({error:"You are not a member of this room."});return;}
  const [room,members,materials]=await Promise.all([
    db().query(`SELECT id,name,description,subject,owner_id AS "ownerId",updated_at AS "updatedAt",$2::text AS role FROM study_rooms WHERE id=$1`,[req.params.id,member.role]),
    db().query(`SELECT user_id AS id,display_name AS name,role,joined_at AS "joinedAt" FROM study_room_members WHERE room_id=$1 ORDER BY joined_at`,[req.params.id]),
    db().query(`SELECT id,kind,title,content,creator_name AS "creatorName",created_at AS "createdAt" FROM study_room_materials WHERE room_id=$1 ORDER BY created_at DESC`,[req.params.id])
  ]);
  res.json({room:room.rows[0],members:members.rows,materials:materials.rows});
}catch(e){next(e);} });

router.post("/rooms/:id/materials",async(req,res,next)=>{try{
  const user=requireSession(req,res);if(!user)return;if(!validId(req.params.id)){res.status(400).json({error:"Invalid room ID."});return;}
  const member=await membership(req.params.id,user);if(!member){res.status(403).json({error:"You are not a member of this room."});return;}
  const kind=req.body?.kind, title=text(req.body?.title,120), content=req.body?.content;
  if(!["note","flashcards","mindmap","quiz"].includes(kind)||!title||!content||typeof content!=="object"||JSON.stringify(content).length>200_000){res.status(400).json({error:"Provide a valid title and study material (maximum 200 KB)."});return;}
  const saved=await db().query(`INSERT INTO study_room_materials(id,room_id,created_by,creator_name,kind,title,content) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,kind,title,content,creator_name AS "creatorName",created_at AS "createdAt"`,[randomUUID(),req.params.id,user,member.display_name,kind,title,JSON.stringify(content)]);
  await db().query("UPDATE study_rooms SET updated_at=now() WHERE id=$1",[req.params.id]);res.status(201).json({material:saved.rows[0]});
}catch(e){next(e);} });

router.post("/rooms/:id/invitation",async(req,res,next)=>{try{
  const user=requireSession(req,res);if(!user)return;if(!validId(req.params.id)){res.status(400).json({error:"Invalid room ID."});return;}
  const member=await membership(req.params.id,user);if(member?.role!=="owner"){res.status(403).json({error:"Only the room owner can manage invitations."});return;}
  const invite=randomBytes(32).toString("base64url"),hash=createHash("sha256").update(invite).digest("hex");await db().query("UPDATE study_rooms SET invite_hash=$1,updated_at=now() WHERE id=$2",[hash,req.params.id]);res.json({inviteToken:invite});
}catch(e){next(e);} });

router.put("/rooms/:id",async(req,res,next)=>{try{
  const user=requireSession(req,res);if(!user)return;if(!validId(req.params.id)){res.status(400).json({error:"Invalid room ID."});return;}
  const member=await membership(req.params.id,user);if(member?.role!=="owner"){res.status(403).json({error:"Only the room owner can update room settings."});return;}
  const name=text(req.body?.name,80),subject=text(req.body?.subject,80),description=typeof req.body?.description==="string"?req.body.description.trim().slice(0,500):undefined;
  if(!name||!subject||description===undefined){res.status(400).json({error:"Room name, subject, and description are required."});return;}
  const updated=await db().query(`UPDATE study_rooms SET name=$1,subject=$2,description=$3,updated_at=now() WHERE id=$4 RETURNING id,name,subject,description,owner_id AS "ownerId",updated_at AS "updatedAt"`,[name,subject,description,req.params.id]);
  res.json({room:{...updated.rows[0],role:"owner"}});
}catch(e){next(e);} });

router.delete("/rooms/:id/members/:memberId",async(req,res,next)=>{try{
  const user=requireSession(req,res);if(!user)return;if(!validId(req.params.id)||!validId(req.params.memberId)){res.status(400).json({error:"Invalid room or member ID."});return;}
  const owner=await membership(req.params.id,user);if(owner?.role!=="owner"){res.status(403).json({error:"Only the room owner can remove members."});return;}
  if(user===req.params.memberId){res.status(400).json({error:"The owner cannot remove themselves."});return;}
  const client=await db().connect();try{await client.query("BEGIN");
    const revoked=createHash("sha256").update(randomBytes(32)).digest("hex");
    await client.query("UPDATE study_rooms SET invite_hash=$1,updated_at=now() WHERE id=$2",[revoked,req.params.id]);
    await client.query("DELETE FROM study_room_members WHERE room_id=$1 AND user_id=$2 AND role='member'",[req.params.id,req.params.memberId]);
    await client.query("COMMIT");
  }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}res.json({ok:true,invitationRevoked:true});
}catch(e){next(e);} });

router.delete("/rooms/:id/membership",async(req,res,next)=>{try{
  const user=requireSession(req,res);if(!user)return;if(!validId(req.params.id)){res.status(400).json({error:"Invalid room ID."});return;}
  const member=await membership(req.params.id,user);if(!member){res.status(404).json({error:"Room membership not found."});return;}if(member.role==="owner"){res.status(400).json({error:"Transfer ownership or delete this room before leaving."});return;}
  await db().query("DELETE FROM study_room_members WHERE room_id=$1 AND user_id=$2",[req.params.id,user]);res.json({ok:true});
}catch(e){next(e);} });

router.delete("/rooms/:id",async(req,res,next)=>{try{
  const user=requireSession(req,res);if(!user)return;if(!validId(req.params.id)){res.status(400).json({error:"Invalid room ID."});return;}
  const member=await membership(req.params.id,user);if(member?.role!=="owner"){res.status(403).json({error:"Only the room owner can delete this room."});return;}
  await db().query("DELETE FROM study_rooms WHERE id=$1",[req.params.id]);res.json({ok:true});
}catch(e){next(e);} });

router.use((err: unknown,_req:Request,res:Response,_next:NextFunction)=>{const e=err as Error & {status?:number};res.status(e.status||500).json({error:e.status?e.message:"Study room request failed."});});
export default router;
