/**
 * Milestone 2 (Profile and Resume Memory) endpoint tests:
 *   GET/PUT/DELETE /api/profile
 *   POST/PUT/DELETE /api/profile/items/:itemId
 *   PUT/DELETE /api/resume
 *
 * Isolation: vitest.config.ts sets DB_PATH=:memory: so each test worker gets a
 * fresh in-memory SQLite DB. NODE_ENV=test prevents server.ts from starting
 * the worker loop or binding a port.
 */

import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { app } from "../../server.js";
import { db } from "../../db/db.js";

afterEach(() => {
  db.prepare("DELETE FROM resumes").run();
  db.prepare("DELETE FROM user_profile_items").run();
  db.prepare("DELETE FROM user_profiles").run();
  db.prepare("DELETE FROM sessions").run();
  db.prepare("DELETE FROM users").run();
});

function extractSessionCookie(res: request.Response): string {
  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie as unknown as string];
  const sessionCookie = cookies.find((c) => c.startsWith("surveyor_session="));
  return (sessionCookie as string).split(";")[0];
}

async function signUpUser(email: string): Promise<{ cookie: string; userId: string }> {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "password123" });
  return { cookie: extractSessionCookie(res), userId: res.body.id as string };
}

describe("GET /api/profile", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).get("/api/profile");
    expect(res.status).toBe(401);
  });

  it("returns empty state for a new authenticated user (not 404)", async () => {
    const { cookie } = await signUpUser("newprofile@example.com");
    const res = await request(app).get("/api/profile").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ profile: null, items: [], resume: null });
  });
});

describe("PUT /api/profile", () => {
  it("creates a profile for the authenticated user", async () => {
    const { cookie } = await signUpUser("createprofile@example.com");

    const res = await request(app)
      .put("/api/profile")
      .set("Cookie", cookie)
      .send({
        full_name: "Alice Example",
        location: "Remote",
        years_experience: 5,
        target_titles: "Senior Engineer",
        notes: "Looking for backend roles.",
      });

    expect(res.status).toBe(200);
    expect(res.body.full_name).toBe("Alice Example");
    expect(res.body.location).toBe("Remote");
    expect(res.body.years_experience).toBe(5);
    expect(res.body.target_titles).toBe("Senior Engineer");
    expect(res.body.notes).toBe("Looking for backend roles.");
    expect(res.body.id).toBeDefined();
    expect(res.body.created_at).toBeDefined();
    expect(res.body.updated_at).toBeDefined();

    const getRes = await request(app).get("/api/profile").set("Cookie", cookie);
    expect(getRes.body.profile.full_name).toBe("Alice Example");
  });

  it("updates/replaces the profile — omitted fields become null", async () => {
    const { cookie } = await signUpUser("replaceprofile@example.com");

    await request(app)
      .put("/api/profile")
      .set("Cookie", cookie)
      .send({ full_name: "Alice Example", location: "Remote", notes: "Old notes" });

    const res = await request(app)
      .put("/api/profile")
      .set("Cookie", cookie)
      .send({ full_name: "Alice Updated" });

    expect(res.status).toBe(200);
    expect(res.body.full_name).toBe("Alice Updated");
    expect(res.body.location).toBeNull();
    expect(res.body.notes).toBeNull();

    const getRes = await request(app).get("/api/profile").set("Cookie", cookie);
    expect(getRes.body.profile.full_name).toBe("Alice Updated");
    expect(getRes.body.profile.location).toBeNull();
  });

  it("trims string fields and stores empty strings as null", async () => {
    const { cookie } = await signUpUser("trimprofile@example.com");

    const res = await request(app)
      .put("/api/profile")
      .set("Cookie", cookie)
      .send({ full_name: "  Alice  ", location: "   ", notes: "" });

    expect(res.status).toBe(200);
    expect(res.body.full_name).toBe("Alice");
    expect(res.body.location).toBeNull();
    expect(res.body.notes).toBeNull();
  });

  it("rejects a negative years_experience", async () => {
    const { cookie } = await signUpUser("negyears@example.com");

    const res = await request(app)
      .put("/api/profile")
      .set("Cookie", cookie)
      .send({ years_experience: -1 });

    expect(res.status).toBe(400);
  });

  it("rejects a non-integer years_experience", async () => {
    const { cookie } = await signUpUser("floatyears@example.com");

    const res = await request(app)
      .put("/api/profile")
      .set("Cookie", cookie)
      .send({ years_experience: 3.5 });

    expect(res.status).toBe(400);
  });

  it("accepts years_experience null", async () => {
    const { cookie } = await signUpUser("nullyears@example.com");

    const res = await request(app)
      .put("/api/profile")
      .set("Cookie", cookie)
      .send({ years_experience: null });

    expect(res.status).toBe(200);
    expect(res.body.years_experience).toBeNull();
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).put("/api/profile").send({ full_name: "Nobody" });
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/profile", () => {
  it("hard-deletes profile and profile items but not resume", async () => {
    const { cookie } = await signUpUser("deleteprofile@example.com");

    await request(app).put("/api/profile").set("Cookie", cookie).send({ full_name: "Alice" });
    await request(app)
      .post("/api/profile/items")
      .set("Cookie", cookie)
      .send({ item_type: "SKILL", title: "TypeScript" });
    await request(app)
      .put("/api/resume")
      .set("Cookie", cookie)
      .send({ resume_text: "My resume text." });

    const res = await request(app).delete("/api/profile").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const getRes = await request(app).get("/api/profile").set("Cookie", cookie);
    expect(getRes.body.profile).toBeNull();
    expect(getRes.body.items).toEqual([]);
    expect(getRes.body.resume).not.toBeNull();
    expect(getRes.body.resume.resume_text).toBe("My resume text.");
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).delete("/api/profile");
    expect(res.status).toBe(401);
  });
});

describe("profile isolation across users", () => {
  it("user A cannot read user B's profile data via GET /api/profile", async () => {
    const { cookie: aCookie } = await signUpUser("profileA@example.com");
    const { cookie: bCookie } = await signUpUser("profileB@example.com");

    await request(app)
      .put("/api/profile")
      .set("Cookie", bCookie)
      .send({ full_name: "User B", notes: "B's private notes" });

    const res = await request(app).get("/api/profile").set("Cookie", aCookie);
    expect(res.status).toBe(200);
    expect(res.body.profile).toBeNull();
  });

  it("user A's PUT /api/profile does not affect user B's profile", async () => {
    const { cookie: aCookie } = await signUpUser("profileUpdA@example.com");
    const { cookie: bCookie } = await signUpUser("profileUpdB@example.com");

    await request(app).put("/api/profile").set("Cookie", bCookie).send({ full_name: "User B" });
    await request(app).put("/api/profile").set("Cookie", aCookie).send({ full_name: "User A" });

    const bRes = await request(app).get("/api/profile").set("Cookie", bCookie);
    expect(bRes.body.profile.full_name).toBe("User B");
  });

  it("user A's DELETE /api/profile does not affect user B's profile", async () => {
    const { cookie: aCookie } = await signUpUser("profileDelA@example.com");
    const { cookie: bCookie } = await signUpUser("profileDelB@example.com");

    await request(app).put("/api/profile").set("Cookie", bCookie).send({ full_name: "User B" });
    await request(app).put("/api/profile").set("Cookie", aCookie).send({ full_name: "User A" });

    await request(app).delete("/api/profile").set("Cookie", aCookie);

    const bRes = await request(app).get("/api/profile").set("Cookie", bCookie);
    expect(bRes.body.profile.full_name).toBe("User B");
  });
});

describe("POST /api/profile/items", () => {
  it("creates an item", async () => {
    const { cookie } = await signUpUser("createitem@example.com");

    const res = await request(app)
      .post("/api/profile/items")
      .set("Cookie", cookie)
      .send({
        item_type: "WORK_HISTORY",
        title: "Engineer at Acme",
        description: "Built things",
        start_date: "2020",
        end_date: "2022",
      });

    expect(res.status).toBe(201);
    expect(res.body.item_type).toBe("WORK_HISTORY");
    expect(res.body.title).toBe("Engineer at Acme");
    expect(res.body.description).toBe("Built things");
    expect(res.body.start_date).toBe("2020");
    expect(res.body.end_date).toBe("2022");
    expect(res.body.id).toBeDefined();
  });

  it("rejects an invalid item_type", async () => {
    const { cookie } = await signUpUser("invaliditemtype@example.com");

    const res = await request(app)
      .post("/api/profile/items")
      .set("Cookie", cookie)
      .send({ item_type: "HOBBY", title: "Chess" });

    expect(res.status).toBe(400);
  });

  it("rejects an empty title", async () => {
    const { cookie } = await signUpUser("emptytitle@example.com");

    const res = await request(app)
      .post("/api/profile/items")
      .set("Cookie", cookie)
      .send({ item_type: "SKILL", title: "   " });

    expect(res.status).toBe(400);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app)
      .post("/api/profile/items")
      .send({ item_type: "SKILL", title: "TypeScript" });
    expect(res.status).toBe(401);
  });
});

describe("PUT /api/profile/items/:itemId", () => {
  it("updates an owned item", async () => {
    const { cookie } = await signUpUser("updateitem@example.com");

    const createRes = await request(app)
      .post("/api/profile/items")
      .set("Cookie", cookie)
      .send({ item_type: "SKILL", title: "TypeScript" });
    const itemId = createRes.body.id as string;

    const res = await request(app)
      .put(`/api/profile/items/${itemId}`)
      .set("Cookie", cookie)
      .send({ item_type: "SKILL", title: "Advanced TypeScript" });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Advanced TypeScript");
  });

  it("returns 404 for another user's item", async () => {
    const { cookie: ownerCookie } = await signUpUser("itemowner@example.com");
    const { cookie: strangerCookie } = await signUpUser("itemstranger@example.com");

    const createRes = await request(app)
      .post("/api/profile/items")
      .set("Cookie", ownerCookie)
      .send({ item_type: "SKILL", title: "TypeScript" });
    const itemId = createRes.body.id as string;

    const res = await request(app)
      .put(`/api/profile/items/${itemId}`)
      .set("Cookie", strangerCookie)
      .send({ item_type: "SKILL", title: "Hijacked" });

    expect(res.status).toBe(404);
  });

  it("returns 404 for a non-existent item", async () => {
    const { cookie } = await signUpUser("noitem@example.com");

    const res = await request(app)
      .put(`/api/profile/items/${randomUUID()}`)
      .set("Cookie", cookie)
      .send({ item_type: "SKILL", title: "TypeScript" });

    expect(res.status).toBe(404);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app)
      .put(`/api/profile/items/${randomUUID()}`)
      .send({ item_type: "SKILL", title: "TypeScript" });
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/profile/items/:itemId", () => {
  it("deletes an owned item", async () => {
    const { cookie } = await signUpUser("deleteitem@example.com");

    const createRes = await request(app)
      .post("/api/profile/items")
      .set("Cookie", cookie)
      .send({ item_type: "SKILL", title: "TypeScript" });
    const itemId = createRes.body.id as string;

    const res = await request(app)
      .delete(`/api/profile/items/${itemId}`)
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const getRes = await request(app).get("/api/profile").set("Cookie", cookie);
    expect(getRes.body.items).toEqual([]);
  });

  it("returns 404 for another user's item", async () => {
    const { cookie: ownerCookie } = await signUpUser("deleteitemowner@example.com");
    const { cookie: strangerCookie } = await signUpUser("deleteitemstranger@example.com");

    const createRes = await request(app)
      .post("/api/profile/items")
      .set("Cookie", ownerCookie)
      .send({ item_type: "SKILL", title: "TypeScript" });
    const itemId = createRes.body.id as string;

    const res = await request(app)
      .delete(`/api/profile/items/${itemId}`)
      .set("Cookie", strangerCookie);

    expect(res.status).toBe(404);

    const getRes = await request(app).get("/api/profile").set("Cookie", ownerCookie);
    expect(getRes.body.items.length).toBe(1);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).delete(`/api/profile/items/${randomUUID()}`);
    expect(res.status).toBe(401);
  });
});

describe("profile item isolation across users", () => {
  it("user A cannot access user B's profile items via GET /api/profile", async () => {
    const { cookie: aCookie } = await signUpUser("itemsIsoA@example.com");
    const { cookie: bCookie } = await signUpUser("itemsIsoB@example.com");

    await request(app)
      .post("/api/profile/items")
      .set("Cookie", bCookie)
      .send({ item_type: "SKILL", title: "B's skill" });

    const res = await request(app).get("/api/profile").set("Cookie", aCookie);
    expect(res.body.items).toEqual([]);
  });
});

describe("PUT /api/resume", () => {
  it("creates resume text", async () => {
    const { cookie } = await signUpUser("createresume@example.com");

    const res = await request(app)
      .put("/api/resume")
      .set("Cookie", cookie)
      .send({ resume_text: "My resume text." });

    expect(res.status).toBe(200);
    expect(res.body.resume_text).toBe("My resume text.");
    expect(res.body.id).toBeDefined();
  });

  it("replaces existing resume text instead of creating duplicates", async () => {
    const { cookie } = await signUpUser("replaceresume@example.com");

    const firstRes = await request(app)
      .put("/api/resume")
      .set("Cookie", cookie)
      .send({ resume_text: "First version." });

    const secondRes = await request(app)
      .put("/api/resume")
      .set("Cookie", cookie)
      .send({ resume_text: "Second version." });

    expect(secondRes.status).toBe(200);
    expect(secondRes.body.id).toBe(firstRes.body.id);
    expect(secondRes.body.resume_text).toBe("Second version.");

    const getRes = await request(app).get("/api/profile").set("Cookie", cookie);
    expect(getRes.body.resume.resume_text).toBe("Second version.");
  });

  it("trims resume_text before storing", async () => {
    const { cookie } = await signUpUser("trimresume@example.com");

    const res = await request(app)
      .put("/api/resume")
      .set("Cookie", cookie)
      .send({ resume_text: "  Resume with padding.  " });

    expect(res.status).toBe(200);
    expect(res.body.resume_text).toBe("Resume with padding.");
  });

  it("rejects empty resume_text", async () => {
    const { cookie } = await signUpUser("emptyresume@example.com");

    const res = await request(app)
      .put("/api/resume")
      .set("Cookie", cookie)
      .send({ resume_text: "   " });

    expect(res.status).toBe(400);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).put("/api/resume").send({ resume_text: "Text." });
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/resume", () => {
  it("hard-deletes resume", async () => {
    const { cookie } = await signUpUser("deleteresume@example.com");

    await request(app)
      .put("/api/resume")
      .set("Cookie", cookie)
      .send({ resume_text: "Resume text." });

    const res = await request(app).delete("/api/resume").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const getRes = await request(app).get("/api/profile").set("Cookie", cookie);
    expect(getRes.body.resume).toBeNull();
  });

  it("is safe when no resume exists", async () => {
    const { cookie } = await signUpUser("nodeleteresume@example.com");

    const res = await request(app).delete("/api/resume").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).delete("/api/resume");
    expect(res.status).toBe(401);
  });
});

describe("resume isolation across users", () => {
  it("user A cannot read user B's resume memory", async () => {
    const { cookie: aCookie } = await signUpUser("resumeIsoA@example.com");
    const { cookie: bCookie } = await signUpUser("resumeIsoB@example.com");

    await request(app)
      .put("/api/resume")
      .set("Cookie", bCookie)
      .send({ resume_text: "B's private resume." });

    const res = await request(app).get("/api/profile").set("Cookie", aCookie);
    expect(res.body.resume).toBeNull();
  });

  it("user A's PUT /api/resume does not affect user B's resume", async () => {
    const { cookie: aCookie } = await signUpUser("resumeUpdA@example.com");
    const { cookie: bCookie } = await signUpUser("resumeUpdB@example.com");

    await request(app)
      .put("/api/resume")
      .set("Cookie", bCookie)
      .send({ resume_text: "B's resume." });
    await request(app)
      .put("/api/resume")
      .set("Cookie", aCookie)
      .send({ resume_text: "A's resume." });

    const bRes = await request(app).get("/api/profile").set("Cookie", bCookie);
    expect(bRes.body.resume.resume_text).toBe("B's resume.");
  });

  it("user A's DELETE /api/resume does not affect user B's resume", async () => {
    const { cookie: aCookie } = await signUpUser("resumeDelA@example.com");
    const { cookie: bCookie } = await signUpUser("resumeDelB@example.com");

    await request(app)
      .put("/api/resume")
      .set("Cookie", bCookie)
      .send({ resume_text: "B's resume." });
    await request(app)
      .put("/api/resume")
      .set("Cookie", aCookie)
      .send({ resume_text: "A's resume." });

    await request(app).delete("/api/resume").set("Cookie", aCookie);

    const bRes = await request(app).get("/api/profile").set("Cookie", bCookie);
    expect(bRes.body.resume.resume_text).toBe("B's resume.");
  });
});
