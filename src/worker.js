// Weather Forward Worker: serves the static site and handles early-access signups.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/signup") {
      if (request.method !== "POST") {
        return json({ ok: false, error: "Method not allowed." }, 405, { Allow: "POST" });
      }
      return handleSignup(request, env, ctx);
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleSignup(request, env, ctx) {
  const wantsJson = (request.headers.get("Accept") || "").includes("application/json");
  const respond = (body, status) =>
    wantsJson ? json(body, status) : redirect(request, body.ok ? (body.status || "ok") : "error");

  let data;
  try {
    data = await readBody(request);
  } catch {
    return respond({ ok: false, error: "Could not read the form." }, 400);
  }

  // Honeypot: real people never fill the hidden "company" field. Pretend success for bots.
  if (data.company) {
    return respond({ ok: true, status: "new" }, 200);
  }

  const email = String(data.email || "").trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
    return respond({ ok: false, error: "Please enter a valid email address." }, 400);
  }

  const source = String(data.source || "landing").slice(0, 64);
  const country = request.cf?.country || null;
  const userAgent = (request.headers.get("User-Agent") || "").slice(0, 256);

  try {
    const result = await env.DB.prepare(
      "INSERT INTO signups (email, source, country, user_agent) VALUES (?1, ?2, ?3, ?4) " +
        "ON CONFLICT(email) DO NOTHING"
    )
      .bind(email, source, country, userAgent)
      .run();

    const isNew = (result.meta?.changes ?? 0) > 0;
    if (isNew) {
      ctx.waitUntil(notifyNewSignup(env, { email, source, country }));
    }
    return respond({ ok: true, status: isNew ? "new" : "exists" }, isNew ? 201 : 200);
  } catch (err) {
    console.error("signup insert failed", err);
    return respond({ ok: false, error: "Something went wrong. Please try again." }, 500);
  }
}

async function readBody(request) {
  const type = request.headers.get("Content-Type") || "";
  if (type.includes("application/json")) {
    return await request.json();
  }
  const form = await request.formData();
  return Object.fromEntries(form.entries());
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

// Fallback for browsers without JavaScript: send them back to the signup section.
function redirect(request, status) {
  const target = new URL("/", request.url);
  target.searchParams.set("signup", status);
  target.hash = "signup";
  return Response.redirect(target.toString(), 303);
}

// Emails the site owner about each new signup. Skipped until the NOTIFY_TO secret is set
// in the Cloudflare dashboard (it must be a verified Email Routing destination address).
async function notifyNewSignup(env, { email, source, country }) {
  if (!env.NOTIFY || !env.NOTIFY_FROM || !env.NOTIFY_TO) return;
  try {
    const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM signups").first("n");
    await env.NOTIFY.send({
      from: { email: env.NOTIFY_FROM, name: "Weather Forward" },
      to: env.NOTIFY_TO,
      subject: `New Weather Forward signup: ${email}`,
      text:
        `${email} just joined the early-access list.\n\n` +
        `Source: ${source}\nCountry: ${country || "unknown"}\nTotal signups: ${total}\n`,
    });
  } catch (err) {
    console.error("signup notification failed", err);
  }
}
