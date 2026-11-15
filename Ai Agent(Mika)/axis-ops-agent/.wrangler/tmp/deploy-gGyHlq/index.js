// index.js
var index_default = {
  async getFirebaseToken(env) {
    const authUrl = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${env.FIREBASE_WEB_API_KEY}`;
    const res = await fetch(authUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: env.WORKER_EMAIL,
        password: env.WORKER_PASSWORD,
        returnSecureToken: true
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Firebase Auth Error: ${JSON.stringify(data)}`);
    return data.idToken;
  },
  async runBriefing(env, specificPayload = null) {
    const today = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
    const baseUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
    const collections = ["leads", "projects", "maint", "clients", "tasks"];
    let allItems = [];
    if (specificPayload) {
      allItems.push(`- [NEW EVENT] ${JSON.stringify(specificPayload)}`);
    } else {
      const idToken = await this.getFirebaseToken(env);
      for (const col of collections) {
        try {
          const res = await fetch(`${baseUrl}/${col}`, {
            headers: { Authorization: `Bearer ${idToken}` }
          });
          if (!res.ok) continue;
          const data = await res.json();
          const docs = data.documents || [];
          docs.forEach((doc) => {
            const fields = doc.fields || {};
            let itemText = "";
            const preferredKeys = [
              "name",
              "title",
              "company",
              "client",
              "contact",
              "stack",
              "budget",
              "stage",
              "status",
              "assignedTo",
              "notes",
              "scope"
            ];
            for (const preferred of preferredKeys) {
              const val = fields[preferred]?.stringValue || fields[preferred]?.integerValue;
              if (val) {
                itemText += `${preferred}: ${val}, `;
              }
            }
            if (itemText) {
              allItems.push(`- [${col.toUpperCase()}] ${itemText.replace(/,\s*$/, "")}`);
            }
          });
        } catch (e) {
          console.error(`Skipping collection ${col}:`, e);
        }
      }
    }
    const summaryContext = allItems.length > 0 ? allItems.join("\n") : "No active tasks, projects, or maintenance items found. All systems are clear.";
    const groqUrl = "https://api.groq.com/openai/v1/chat/completions";
    let prompt = "";
    if (specificPayload) {
      const itemData = specificPayload.item || specificPayload;
      prompt = `You are Bella, the executive AI Operations Assistant for AXIS Digital Engineering. A new event or update just came in: ${JSON.stringify(itemData)}. 
Write a crisp, factual voice update for Boss announcing this exact update. 
CRITICAL SPEAKING RULES: 
1. NEVER speak database IDs, random tracking hashes, field keys, or technical codes aloud. 
2. When mentioning budgets or numbers, state the numbers clearly without adding any currency labels or words like dollars.
3. Keep it under 50 words, conversational, formatted strictly as spoken dialogue with no markdown, asterisks, or emojis. Always address the user as Boss.`;
    } else {
      prompt = `You are Bella, the executive AI Operations Assistant for AXIS Digital Engineering. Write a crisp morning operational briefing for Boss based strictly on these actual current database items:

${summaryContext}
CRITICAL SPEAKING RULES: 
1. NEVER speak database IDs, unique hash strings, or raw field labels aloud. 
2. When mentioning budgets or numbers, state the numbers clearly without adding any currency labels or words like dollars.
3. Only report items explicitly listed above. 
Keep it under 100 words, conversational, formatted strictly as spoken dialogue with no markdown, asterisks, or emojis. Always address the user as Boss.`;
    }
    const groqResponse = await fetch(groqUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        messages: [{ role: "user", content: prompt }]
      })
    });
    const groqData = await groqResponse.json();
    if (!groqResponse.ok || !groqData.choices?.[0]?.message?.content) {
      throw new Error(`Groq API Error: ${JSON.stringify(groqData)}`);
    }
    const spokenText = groqData.choices[0].message.content;
    const audioBuffer = await this.generateAudio(env, spokenText);
    const formData = new FormData();
    formData.append(
      "file",
      new Blob([audioBuffer], { type: "audio/mpeg" }),
      `axis-update-${today}.mp3`
    );
    formData.append(
      "payload_json",
      JSON.stringify({
        content: `\u{1F3A7} **AXIS Ops Update (${today})**
> ${spokenText}`
      })
    );
    const discordResponse = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      body: formData
    });
    if (!discordResponse.ok) {
      throw new Error(`Discord Webhook error: ${await discordResponse.text()}`);
    }
  },
  async generateAudio(env, text) {
    const VOICE_ID = env.ELEVENLABS_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";
    const ttsResponse = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_flash_v2_5",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 }
        })
      }
    );
    if (!ttsResponse.ok) {
      throw new Error(`ElevenLabs error: ${await ttsResponse.text()}`);
    }
    return await ttsResponse.arrayBuffer();
  },
  async scheduled(event, env, ctx) {
    await this.runBriefing(env);
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-axis-secret"
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    if (url.pathname === "/trigger") {
      const secret = request.headers.get("x-axis-secret");
      if (env.TRIGGER_SECRET && secret !== env.TRIGGER_SECRET) {
        return new Response("Unauthorized", { status: 401, headers: corsHeaders });
      }
      try {
        let payload = null;
        if (request.method === "POST") {
          payload = await request.json().catch(() => null);
        }
        await this.runBriefing(env, payload);
        return new Response("\u2705 AXIS Executive Agent executed successfully!", {
          status: 200,
          headers: corsHeaders
        });
      } catch (error) {
        return new Response(`\u274C Error: ${error.message}`, {
          status: 500,
          headers: corsHeaders
        });
      }
    }
    return new Response("AXIS Executive Ops Agent is online.", {
      status: 200,
      headers: corsHeaders
    });
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
