import threading
import io
import base64
import requests
import sounddevice as sd
import soundfile as sf
import numpy as np
import tkinter as tk

# Configuration
WORKER_CALL_URL = "https://axis-ops-agent.axis-ops.workers.dev/call"
GROQ_API_KEY = "YOUR_GROQ_API_KEY_HERE"  # Optional: Paste your Groq key here if using local Whisper

class BellaSoftphone(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("AXIS Direct Line - Bella COO")
        self.geometry("340x500")
        self.configure(bg="#09090b")
        self.resizable(False, False)

        self.is_connected = False
        self.is_recording = False
        self.conversation_history = []
        self.recorded_audio = []
        self.stream = None

        self.setup_ui()

    def setup_ui(self):
        # Header Status
        self.state_label = tk.Label(self, text="AXIS DIRECT LINE", fg="#a1a1aa", bg="#09090b", font=("Arial", 9, "bold"))
        self.state_label.pack(pady=20)

        # Avatar Box
        self.avatar_frame = tk.Frame(self, bg="#18181b", width=90, height=90, highlightbackground="#3f3f46", highlightthickness=2)
        self.avatar_frame.pack(pady=10)
        self.avatar_frame.pack_propagate(False)
        
        self.avatar_label = tk.Label(self.avatar_frame, text="B", fg="#fff", bg="#18181b", font=("Arial", 28, "bold"))
        self.avatar_label.pack(expand=True)

        self.name_label = tk.Label(self, text="Bella", fg="#fff", bg="#09090b", font=("Arial", 20, "bold"))
        self.name_label.pack()

        self.sub_label = tk.Label(self, text="Chief Operating AI", fg="#10b981", bg="#09090b", font=("Arial", 11))
        self.sub_label.pack(pady=5)

        # Transcript Box
        self.transcript_box = tk.Text(self, height=5, wrap=tk.WORD, bg="#18181b", fg="#d4d4d8", bd=0, highlightthickness=1, highlightbackground="#27272a")
        self.transcript_box.pack(padx=20, pady=10, fill=tk.X)
        self.transcript_box.insert(tk.END, "Ready. Click below to simulate incoming call.")
        self.transcript_box.config(state=tk.DISABLED)

        # Controls Frame
        self.control_frame = tk.Frame(self, bg="#09090b")
        self.control_frame.pack(pady=20)

        self.sim_btn = tk.Button(self.control_frame, text="Simulate Incoming Call", bg="#27272a", fg="#fff", bd=0, padx=15, pady=8, font=("Arial", 10), command=self.trigger_incoming_call)
        self.sim_btn.pack()

        # Push-to-Talk and Hangup (Hidden until call connects)
        self.talk_btn = tk.Button(self.control_frame, text="Hold to Speak", bg="#10b981", fg="#fff", bd=0, padx=20, pady=12, font=("Arial", 11, "bold"))
        self.talk_btn.bind("<ButtonPress-1>", self.start_recording)
        self.talk_btn.bind("<ButtonRelease-1>", self.stop_recording)

        self.hangup_btn = tk.Button(self.control_frame, text="End Call", bg="#ef4444", fg="#fff", bd=0, padx=20, pady=8, font=("Arial", 10, "bold"), command=self.end_call)

    def log_transcript(self, text):
        self.transcript_box.config(state=tk.NORMAL)
        self.transcript_box.delete("1.0", tk.END)
        self.transcript_box.insert(tk.END, text)
        self.transcript_box.config(state=tk.DISABLED)

    def trigger_incoming_call(self):
        self.state_label.config(text="INCOMING CALL...")
        self.sim_btn.pack_forget()
        self.talk_btn.pack(side=tk.LEFT, padx=5)
        self.hangup_btn.pack(side=tk.LEFT, padx=5)
        self.sub_label.config(text="Connecting to Bella...")
        self.after(500, self.answer_call)

    def answer_call(self):
        self.is_connected = True
        self.conversation_history = []
        self.state_label.config(text="CONNECTED")
        self.sub_label.config(text="Bella is speaking...")
        
        # Start initial greeting from worker
        threading.Thread(target=self.send_to_worker, args=("", True), daemon=True).start()

    def start_recording(self, event):
        if not self.is_connected or self.is_recording: return
        self.is_recording = True
        self.recorded_audio = []
        self.sub_label.config(text="Recording...")

        def callback(indata, frames, time, status):
            if self.is_recording:
                self.recorded_audio.append(indata.copy())

        self.stream = sd.InputStream(samplerate=16000, channels=1, callback=callback, dtype='int16')
        self.stream.start()

    def stop_recording(self, event):
        if not self.is_connected or not self.is_recording: return
        self.is_recording = False
        if self.stream:
            self.stream.stop()
            self.stream.close()
            self.stream = None

        self.sub_label.config(text="Transcribing your voice...")

        audio_data = np.concatenate(self.recorded_audio, axis=0)
        wav_buffer = io.BytesIO()
        sf.write(wav_buffer, audio_data, 16000, format='WAV', subtype='PCM_16')
        wav_buffer.seek(0)
        wav_bytes = wav_buffer.read()

        threading.Thread(target=self.process_voice_turn, args=(wav_bytes,), daemon=True).start()

    def transcribe_with_whisper(self, wav_bytes):
        if not GROQ_API_KEY or GROQ_API_KEY == "YOUR_GROQ_API_KEY_HERE":
            return "Give me an update on our leads"
        
        url = "https://api.groq.com/openai/v1/audio/transcriptions"
        headers = {"Authorization": f"Bearer {GROQ_API_KEY}"}
        files = {"file": ("audio.wav", wav_bytes, "audio/wav")}
        data = {"model": "whisper-large-v3-turbo", "language": "en"}

        try:
            response = requests.post(url, headers=headers, files=files, data=data, timeout=10)
            if response.status_code == 200:
                return response.json().get("text", "").strip()
        except Exception as e:
            print("Whisper connection error:", e)
        return ""

    def process_voice_turn(self, wav_bytes):
        user_text = self.transcribe_with_whisper(wav_bytes)
        if not user_text:
            self.sub_label.config(text="Didn't catch that. Hold to speak.")
            return

        self.log_transcript(f"You: \"{user_text}\"")
        self.send_to_worker(user_text, False)

    def send_to_worker(self, user_text, is_opening):
        if not is_opening and user_text:
            self.conversation_history.append({"role": "user", "content": user_text})

        try:
            res = requests.post(WORKER_CALL_URL, json={
                "messages": self.conversation_history,
                "isOpeningCall": is_opening
            }, timeout=25)
            data = res.json()

            if "error" in data:
                self.log_transcript("Error: " + data["error"])
                return

            reply_text = data["replyText"]
            self.conversation_history.append({"role": "assistant", "content": reply_text})
            self.log_transcript(f"Bella: \"{reply_text}\"")
            self.sub_label.config(text="Bella is speaking...")

            audio_bytes = base64.b64decode(data["audioBase64"])
            data_np, samplerate = sf.read(io.BytesIO(audio_bytes))
            sd.play(data_np, samplerate)
            sd.wait()
            sd.sleep(300)

            if data.get("hangUp", False):
                self.end_call()
                return

            self.sub_label.config(text="Hold 'Hold to Speak' to reply")

        except Exception as e:
            self.log_transcript(f"Connection error: {str(e)}")

    def end_call(self):
        self.is_connected = False
        if self.stream:
            try:
                self.stream.stop()
                self.stream.close()
            except:
                pass
        self.state_label.config(text="CALL ENDED")
        self.sub_label.config(text="Chief Operating AI")
        self.log_transcript("Call finished.")
        self.talk_btn.pack_forget()
        self.hangup_btn.pack_forget()
        self.sim_btn.pack()

if __name__ == "__main__":
    app = BellaSoftphone()
    app.mainloop()