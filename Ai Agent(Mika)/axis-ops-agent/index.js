export default {
  async runBriefing(env, specificPayload = null) {
    const today = new Date().toISOString().split("T")[0];
    const baseUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;

    const collections = ["maint", "projects", "leads", "tasks"];
    let allItems = [];

    if (specificPayload) {
      allItems.push(`- [NEW EVENT] ${JSON.stringify(specificPayload)}`);
    } else {
      for (const col of collections) {
        try {
          const res = await fetch(`${baseUrl}/${col}`);
          if (!res.ok) continue;
          const data = await res.json();
          const docs = data.documents || [];
          
          docs.forEach((doc) => {
            const fields = doc.fields || {};
            let itemText = "";
            const preferredKeys = ["name", "title", "client", "taskName", "description", "text", "scope", "notes"];
            
            for (const preferred of preferredKeys) {
              if (fields[preferred]?.stringValue) {
                itemText += `${preferred}: ${fields[preferred].stringValue}, `;
              }
            }

            if (!itemText) {
              for (const key of Object.keys(fields)) {
                const val = fields[key]?.stringValue || fields[key]?.integerValue;
                if (val) {
                  itemText = `${key}: ${val}`;
                  break;
                }
              }
            }

            if (itemText) {
              allItems.push(`- [${col.toUpperCase()}] ${itemText.replace(/,\s*$/, '')}`);
            }
          });
        } catch (e) {
          console.error(`Error fetching collection ${col}:`, e);
        }
      }
    }

    const summaryContext =
      allItems.length > 0
        ? allItems.join("\n")
        : "No active tasks, projects, or maintenance items found. All systems are clear.";

    const groqUrl = "https://api.groq.com/openai/v1/chat/completions";
    
    let prompt = "";
    if (specificPayload) {
      const itemData = specificPayload.item || specificPayload;
      prompt = `You are the executive AI Operations Assistant for AXIS Digital Engineering. A new event or lead just came in: ${JSON.stringify(itemData)}. 
Write a crisp, alert voice update for Boss announcing this new item immediately. 
CRITICAL RULE: Look closely at the notes, scope, or description provided in the item data. If the notes or scope fields are empty, blank, or vague, DO NOT invent, fabricate, or guess any receipt issues, bugs, or problems. State clearly that no specific details or issues have been logged for this item yet.
Keep it under 60 words, conversational, formatted strictly as spoken dialogue with no markdown, asterisks, or emojis, and always address the user as Boss.`;
    } else if (allItems.length > 0) {
      prompt = `You are the executive AI Operations Assistant for AXIS Digital Engineering. Write a crisp, energetic, natural-sounding morning voice briefing for Boss based on today's (${today}) operational items below. 
CRITICAL RULE: Only report what is explicitly written in the notes or descriptions. Do not invent, fabricate, or guess issues if notes are missing or blank.
Keep it under 120 words, conversational, and formatted strictly as spoken dialogue with no markdown, asterisks, or emojis. Mention clear human-readable names or descriptions rather than database IDs. Always address the user as Boss:\n\n${summaryContext}`;
    } else {
      prompt = `You are the executive AI Operations Assistant for AXIS Digital Engineering. Write a short, friendly, professional morning voice update for Boss stating that all systems are nominal and there is no required work or active tasks on the docket for today (${today}). Keep it under 40 words, conversational, and formatted strictly as spoken dialogue with no markdown, asterisks, or emojis. Always address the user as Boss.`;
    }

    const groqResponse = await fetch(groqUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        messages: [{ role: "user", content: prompt }],
      }),
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
      `axis-briefing-${today}.mp3`
    );
    formData.append(
      "payload_json",
      JSON.stringify({
        content: `🎧 **AXIS Executive Briefing (${today})**\n> ${spokenText}`,
      })
    );

    const discordResponse = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      body: formData,
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
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: text,
          model_id: "eleven_flash_v2_5",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
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
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === "/trigger") {
      try {
        let payload = null;
        if (request.method === "POST") {
          payload = await request.json().catch(() => null);
        }

        await this.runBriefing(env, payload);
        return new Response("✅ AXIS Executive Agent executed successfully!", { status: 200, headers: corsHeaders });
      } catch (error) {
        return new Response(`❌ Error: ${error.message}`, { status: 500, headers: corsHeaders });
      }
    }

    return new Response("AXIS Executive Ops Agent is online.", { status: 200, headers: corsHeaders });
  },
};