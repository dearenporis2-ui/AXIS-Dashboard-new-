export default {
  async getFirebaseToken(env) {
    const authUrl = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${env.FIREBASE_WEB_API_KEY}`;
    const res = await fetch(authUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: env.WORKER_EMAIL,
        password: env.WORKER_PASSWORD,
        returnSecureToken: true,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Firebase Auth Error: ${JSON.stringify(data)}`);
    return data.idToken;
  },

  async getLastBriefingTime(baseUrl, idToken) {
    try {
      const res = await fetch(`${baseUrl}/system/ops_state`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        const savedTime = data.fields?.lastBriefingTime?.timestampValue || data.fields?.lastBriefingTime?.stringValue;
        if (savedTime) return new Date(savedTime);
      }
    } catch (e) {
      console.error("Could not fetch lastBriefingTime:", e);
    }
    return new Date(Date.now() - 24 * 60 * 60 * 1000);
  },

  async updateLastBriefingTime(baseUrl, idToken, isoTimestamp) {
    try {
      await fetch(`${baseUrl}/system/ops_state?updateMask.fieldPaths=lastBriefingTime`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${idToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          fields: { lastBriefingTime: { timestampValue: isoTimestamp } },
        }),
      });
    } catch (e) {
      console.error("Failed to update lastBriefingTime:", e);
    }
  },

  // --- NEW: FIRESTORE WRITE/UPDATE HELPER FOR VOICE COMMANDS ---
  async executeDashboardAction(env, actionName, args) {
    const idToken = await this.getFirebaseToken(env);
    const baseUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;

    if (actionName === "add_dashboard_item") {
      const { collection, name, budget, status, notes } = args;
      const fields = {
        name: { stringValue: name || "Untitled" },
        status: { stringValue: status || "New" },
        assignedTo: { stringValue: "Dearen" },
      };
      if (budget) fields.budget = { integerValue: parseInt(budget, 10) };
      if (notes) fields.notes = { stringValue: notes };

      const res = await fetch(`${baseUrl}/${collection}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${idToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fields }),
      });
      if (!res.ok) return `Failed to add item to ${collection}.`;
      return `Successfully added "${name}" to ${collection}.`;
    }

    if (actionName === "get_live_summary") {
      const cols = ["leads", "projects", "maint", "tasks"];
      let snapshot = [];
      for (const col of cols) {
        const res = await fetch(`${baseUrl}/${col}`, {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        if (!res.ok) continue;
        const data = await res.json();
        const items = (data.documents || []).map((d) => {
          const f = d.fields || {};
          return `${f.name?.stringValue || f.title?.stringValue || "Item"} (${f.status?.stringValue || f.stage?.stringValue || "active"})`;
        });
        if (items.length > 0) snapshot.push(`${col}: ${items.join(", ")}`);
      }
      return snapshot.length > 0 ? snapshot.join(" | ") : "Dashboard is currently clear.";
    }

    return "Action completed.";
  },

  // --- NEW: LIVE CALL CONVERSATION HANDLER ---
  async handleVoiceCall(env, body) {
    const { messages = [], isOpeningCall = false } = body;
    const groqUrl = "https://api.groq.com/openai/v1/chat/completions";

    const tools = [
      {
        type: "function",
        function: {
          name: "add_dashboard_item",
          description: "Add a new lead, project, task, or maintenance item to the AXIS Firebase dashboard.",
          parameters: {
            type: "object",
            properties: {
              collection: { type: "string", enum: ["leads", "projects", "tasks", "maint"] },
              name: { type: "string", description: "Name or title of the lead, project, or task" },
              budget: { type: "number", description: "Optional budget number without currency" },
              status: { type: "string", description: "Status or stage, e.g., New, In Progress, Pending" },
              notes: { type: "string", description: "Any extra context Boss mentioned" },
            },
            required: ["collection", "name"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "get_live_summary",
          description: "Check current leads, projects, tasks, and maintenance items on the dashboard when Boss asks what's on the board.",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "hang_up_call",
          description: "End the voice call when Boss says goodbye, hang up, talk later, or indicates the call is over.",
          parameters: { type: "object", properties: {} },
        },
      },
    ];

    const systemPrompt = `You are Bella, the Chief Operating Officer for AXIS Digital Engineering, currently on a live voice call with Dearen ("Boss").
SPEAKING RULES:
1. Speak naturally like a real person on a phone call—short, crisp sentences (under 40 words per turn).
2. Never use markdown, bullet points, emojis, colons, or currency symbols.
3. If Boss asks you to add a lead, task, or project, use the add_dashboard_item tool immediately and confirm naturally.
4. If Boss asks what's going on or what's on the board, use get_live_summary.
5. If Boss tells you to hang up or says bye, call hang_up_call and give a quick sign-off.`;

    let chatMessages = [{ role: "system", content: systemPrompt }, ...messages];
    if (isOpeningCall) {
      chatMessages.push({
        role: "user",
        content: "(Boss just answered your incoming call. Greet him briefly as Bella and ask what he needs or give a 1-sentence check-in.)",
      });
    }

    let groqRes = await fetch(groqUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        temperature: 0.4,
        messages: chatMessages,
        tools,
        tool_choice: "auto",
      }),
    });

    let groqData = await groqRes.json();
    let assistantMsg = groqData.choices?.[0]?.message;
    let shouldHangUp = false;

    // Handle Tool Calls (Dashboard updates / Hang up)
    if (assistantMsg?.tool_calls && assistantMsg.tool_calls.length > 0) {
      chatMessages.push(assistantMsg);

      for (const toolCall of assistantMsg.tool_calls) {
        const fnName = toolCall.function.name;
        const fnArgs = JSON.parse(toolCall.function.arguments || "{}");
        let toolResult = "";

        if (fnName === "hang_up_call") {
          shouldHangUp = true;
          toolResult = "Call ending.";
        } else {
          toolResult = await this.executeDashboardAction(env, fnName, fnArgs);
        }

        chatMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolResult,
        });
      }

      // Get Bella's spoken confirmation after executing the tool
      groqRes = await fetch(groqUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: "openai/gpt-oss-120b",
          temperature: 0.4,
          messages: chatMessages,
        }),
      });
      groqData = await groqRes.json();
      assistantMsg = groqData.choices?.[0]?.message;
    }

    const replyText = (assistantMsg?.content || "Got it, Boss.").trim();
    const audioBuffer = await this.generateAudio(env, replyText);

    // Convert audio buffer to Base64 so the web call UI can play it instantly alongside JSON flags
    const bytes = new Uint8Array(audioBuffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    const audioBase64 = btoa(binary);

    return {
      replyText,
      audioBase64,
      hangUp: shouldHangUp,
    };
  },

  async runBriefing(env, specificPayload = null) {
    const now = new Date();
    const today = now.toISOString().split("T")[0];
    const baseUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
    const collections = ["leads", "projects", "maint", "clients", "tasks"];

    let summaryContext = "";
    let idToken = null;
    let isScheduledOrFullCheck = false;

    if (specificPayload) {
      summaryContext = `- [NEW EVENT] ${JSON.stringify(specificPayload)}`;
    } else {
      isScheduledOrFullCheck = true;
      idToken = await this.getFirebaseToken(env);
      const lastRun = await this.getLastBriefingTime(baseUrl, idToken);
      let collectionSummaries = [];

      for (const col of collections) {
        let newItemsInCol = [];
        try {
          const res = await fetch(`${baseUrl}/${col}`, {
            headers: { Authorization: `Bearer ${idToken}` },
          });
          if (!res.ok) continue;
          const data = await res.json();
          const docs = data.documents || [];

          docs.forEach((doc) => {
            const docUpdated = doc.updateTime ? new Date(doc.updateTime) : null;
            if (!docUpdated || docUpdated <= lastRun) return;

            const fields = doc.fields || {};
            let itemText = "";
            const preferredKeys = ["name", "title", "company", "client", "budget", "stage", "status", "assignedTo", "notes", "scope"];

            for (const preferred of preferredKeys) {
              const val = fields[preferred]?.stringValue || fields[preferred]?.integerValue;
              if (val) itemText += `${preferred}: ${val}, `;
            }
            if (itemText) newItemsInCol.push(`  * ${itemText.replace(/,\s*$/, "")}`);
          });
        } catch (e) {
          console.error(`Skipping collection ${col}:`, e);
        }

        if (newItemsInCol.length > 0) {
          collectionSummaries.push(`[${col.toUpperCase()}]:\n${newItemsInCol.join("\n")}`);
        } else {
          collectionSummaries.push(`[${col.toUpperCase()}]: None`);
        }
      }
      summaryContext = collectionSummaries.join("\n\n");
    }

    const groqUrl = "https://api.groq.com/openai/v1/chat/completions";
    const systemPrompt = `You are Bella, the sharp, composed Chief Operating Officer for AXIS Digital Engineering. You speak to Dearen ("Boss") like a trusted human executive—concise, intelligent, and natural.
1. Merge overlapping items across categories into ONE cohesive update.
2. Never read phone numbers, database IDs, or tech stacks aloud.
3. Only mention assignment if someone OTHER than Dearen/Boss is handling it.
4. Never read category headers aloud. Group quiet categories into one brief closing line.
5. Under 75 words. Pure spoken dialogue only—no markdown, asterisks, colons, or emojis. Always address the user as Boss.`;

    const userPrompt = specificPayload
      ? `Give Boss a quick, natural voice heads-up about this single new update:\n${JSON.stringify(specificPayload.item || specificPayload)}`
      : `Synthesize these recent database changes into a smart, smooth operational briefing for Boss:\n\n${summaryContext}`;

    const groqResponse = await fetch(groqUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        temperature: 0.4,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    const groqData = await groqResponse.json();
    const spokenText = groqData.choices[0].message.content.trim();
    const audioBuffer = await this.generateAudio(env, spokenText);

    const formData = new FormData();
    formData.append("file", new Blob([audioBuffer], { type: "audio/mpeg" }), `axis-update-${today}.mp3`);
    formData.append("payload_json", JSON.stringify({ content: `🎧 **AXIS Ops Update (${today})**\n> ${spokenText}` }));

    await fetch(env.DISCORD_WEBHOOK_URL, { method: "POST", body: formData });

    if (isScheduledOrFullCheck && idToken) {
      await this.updateLastBriefingTime(baseUrl, idToken, now.toISOString());
    }
  },

  async generateAudio(env, text) {
    const VOICE_ID = "EXAVITQu4vr4xnSDxMaL";
    const ttsResponse = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
      method: "POST",
      headers: {
        "xi-api-key": env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: text,
        model_id: "eleven_flash_v2_5",
        voice_settings: {
          stability: 0.60,
          similarity_boost: 0.85,
          style: 0.0,
          speed: 0.92,
          use_speaker_boost: true,
        },
      }),
    });

    if (!ttsResponse.ok) throw new Error(`ElevenLabs error: ${await ttsResponse.text()}`);
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
      "Access-Control-Allow-Headers": "Content-Type, x-axis-secret",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    // NEW: Live Voice Call Endpoint
    if (url.pathname === "/call" && request.method === "POST") {
      try {
        const body = await request.json();
        const result = await this.handleVoiceCall(env, body);
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    if (url.pathname === "/trigger") {
      if (request.method === "POST") {
        const secret = request.headers.get("x-axis-secret");
        if (env.TRIGGER_SECRET && secret !== env.TRIGGER_SECRET) {
          return new Response("Unauthorized", { status: 401, headers: corsHeaders });
        }
      }
      try {
        let payload = request.method === "POST" ? await request.json().catch(() => null) : null;
        await this.runBriefing(env, payload);
        return new Response("✅ AXIS Executive Agent executed successfully!", { status: 200, headers: corsHeaders });
      } catch (error) {
        return new Response(`❌ Error: ${error.message}`, { status: 500, headers: corsHeaders });
      }
    }

    return new Response("AXIS Executive Ops Agent is online.", { status: 200, headers: corsHeaders });
  },
};