// server.js

// Import required modules
const fs = require("fs");
const http = require("http");
const path = require("path");
const dotenv = require("dotenv");
dotenv.config();

// Importation du module ws pour créer des WebSocket
const WebSocket = require("ws");

// Twilio et HttpDispatcher
const HttpDispatcher = require("httpdispatcher");
const { server: WebSocketServer } = require("websocket");
const dispatcher = new HttpDispatcher();

// Utilisation du port défini dans process.env.PORT (Railway fournit cette variable) ou 8080 par défaut
const HTTP_SERVER_PORT = process.env.PORT || 8080;
let streamSid = ''; // Pour stocker l'ID de la session de streaming

// Twilio REST API client (assurez-vous d'installer la librairie Twilio)
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioNumber = process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_NUMBER;
let twilioClient;
if (accountSid && authToken) {
  // Charger la librairie Twilio et initialiser le client REST
  const twilio = require("twilio");
  twilioClient = twilio(accountSid, authToken);
  console.log("Twilio client initialisé pour les appels sortants.");
} else {
  console.warn("Twilio credentials manquants. L'endpoint /outbound ne fonctionnera pas.");
}

// Créer le serveur HTTP pour gérer les requêtes
const wsserver = http.createServer(handleRequest);

// Deepgram Speech to Text
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);
let keepAlive;

// OpenAI
const OpenAI = require('openai');
const openai = new OpenAI();

// Deepgram Text to Speech Websocket URL (possibilité de le définir via DEEPGRAM_TTS_WS_URL)
const deepgramTTSWebsocketURL = process.env.DEEPGRAM_TTS_WS_URL || 'wss://api.deepgram.com/v1/speak?encoding=mulaw&sample_rate=8000&container=none';

// Performance Timings et autres variables
let llmStart = 0;
let ttsStart = 0;
let firstByte = true;
let speaking = false;
let send_first_sentence_input_time = null;
const chars_to_check = [".", ",", "!", "?", ";", ":"];

// Fonction pour gérer les requêtes HTTP
function handleRequest(request, response) {
  try {
    dispatcher.dispatch(request, response);
  } catch (err) {
    console.error(err);
  }
}

/*
  Endpoint de debug
*/
dispatcher.onGet("/", function (req, res) {
  console.log('GET /');
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hello, World!');
});

/*
  Endpoint pour le TwiML
  Lecture du fichier streams.xml, remplacement du placeholder <YOUR NGROK URL>
  par la variable SERVER (sans protocole) définie dans le fichier .env.
*/
dispatcher.onPost("/twiml", function (req, res) {
  console.log("POST /twiml");
  let filePath = path.join(__dirname, "templates", "streams.xml");
  try {
    let streamsXML = fs.readFileSync(filePath, "utf8");
    // Récupérer le domaine du serveur depuis process.env.SERVER
    let serverUrl = process.env.SERVER || "localhost";
    // Retirer "http://" ou "https://" s'ils sont présents
    serverUrl = serverUrl.replace(/^https?:\/\//, '');
    // Remplacer le placeholder dans le fichier streams.xml par le domaine du serveur
    streamsXML = streamsXML.replace("<YOUR NGROK URL>", serverUrl);
    res.writeHead(200, {
      "Content-Type": "text/xml",
      "Content-Length": Buffer.byteLength(streamsXML)
    });
    res.end(streamsXML);
  } catch (err) {
    console.error("Erreur lors de la lecture du fichier streams.xml :", err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal Server Error");
  }
});

/*
  Endpoint pour les appels sortants (outbound)
  Reçoit une requête POST avec le numéro à appeler et initie un appel via Twilio.
  Twilio utilisera ensuite l'endpoint /twiml pour les instructions de l'appel.
*/
dispatcher.onPost("/outbound", function (req, res) {
  console.log("POST /outbound");
  // Accumuler le corps de la requête
  let body = "";
  req.on("data", chunk => {
    body += chunk;
  });
  req.on("end", async () => {
    let data;
    try {
      data = JSON.parse(body);
    } catch (err) {
      console.error("Erreur de parsing du corps de la requête /outbound:", err);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Invalid JSON" }));
      return;
    }
    console.log("Corps de la requête /outbound:", data);
    // Extraire les paramètres (numéros de téléphone)
    const toNumber = data.to || data.number;
    const fromNumber = twilioNumber || data.from;
    // Vérifier les prérequis
    if (!twilioClient) {
      console.error("Twilio client non initialisé. Vérifiez les identifiants Twilio.");
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Twilio client not initialized" }));
      return;
    }
    if (!toNumber || !fromNumber) {
      console.error("Numéro de destination ou numéro source manquant. to:", toNumber, "from:", fromNumber);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Missing 'to' or 'from' number" }));
      return;
    }
    console.log(`Initiation de l'appel vers ${toNumber} depuis ${fromNumber} via Twilio...`);
    try {
      // Construire l'URL du TwiML qui sera appelé une fois l'appel connecté
      let twimlUrl = process.env.SERVER || "";
      if (twimlUrl) {
        // S'assurer que l'URL contient le protocole
        if (!twimlUrl.startsWith("http")) {
          twimlUrl = "https://" + twimlUrl;
        }
        // Chemin complet vers l'endpoint /twiml
        twimlUrl = twimlUrl.replace(/\/$/, "") + "/twiml";
      } else {
        // Si aucune URL de serveur n'est fournie, utiliser l'URL locale
        twimlUrl = `http://localhost:${HTTP_SERVER_PORT}/twiml`;
      }
      console.log("TwiML URL utilisé pour l'appel:", twimlUrl);
      // Initier l'appel sortant via l'API Twilio
      const call = await twilioClient.calls.create({
        to: toNumber,
        from: fromNumber,
        url: twimlUrl,
        method: "POST"  // Twilio fera une requête POST sur /twiml
      });
      console.log("Appel sortant initié via Twilio. Call SID:", call.sid);
      // Répondre avec succès et le SID de l'appel pour confirmer
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, callSid: call.sid }));
    } catch (err) {
      console.error("Erreur lors de l'initiation de l'appel Twilio:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  });
});

/*
  Serveur WebSocket pour Twilio
  Accepter uniquement les connexions sur le chemin "/streams"
*/
const mediaws = new WebSocketServer({
  httpServer: wsserver,
  autoAcceptConnections: false,
});

mediaws.on("request", function (request) {
  if (request.resourceURL.pathname === "/streams") {
    let connection = request.accept();
    console.log("twilio: Connection accepted on /streams");
    new MediaStream(connection);
  } else {
    request.reject();
    console.log("twilio: Connection rejected, invalid URL:", request.resourceURL.pathname);
  }
});

/*
  Classe pour gérer le flux média (Twilio bidirectionnel)
*/
class MediaStream {
  constructor(connection) {
    this.connection = connection;
    this.deepgram = setupDeepgram(this);
    this.deepgramTTSWebsocket = setupDeepgramWebsocket(this);
    connection.on("message", this.processMessage.bind(this));
    connection.on("close", this.close.bind(this));
    this.hasSeenMedia = false;
    this.messages = [];
    this.repeatCount = 0;
  }

  processMessage(message) {
    if (message.type === "utf8") {
      let data = JSON.parse(message.utf8Data);
      if (data.event === "connected") {
        console.log("twilio: Connected event received:", data);
      }
      if (data.event === "start") {
        console.log("twilio: Start event received:", data);
      }
      if (data.event === "media") {
        if (!this.hasSeenMedia) {
          console.log("twilio: Media event received:", data);
          console.log("twilio: Suppressing additional messages...");
          this.hasSeenMedia = true;
        }
        if (!streamSid) {
          console.log('twilio: streamSid =', streamSid);
          streamSid = data.streamSid;
        }
        if (data.media.track === "inbound") {
          let rawAudio = Buffer.from(data.media.payload, 'base64');
          this.deepgram.send(rawAudio);
        }
      }
      if (data.event === "mark") {
        console.log("twilio: Mark event received", data);
      }
      if (data.event === "close") {
        console.log("twilio: Close event received:", data);
        this.close();
      }
    } else if (message.type === "binary") {
      console.log("twilio: binary message received (not supported)");
    }
  }

  close() {
    console.log("twilio: Closed");
  }
}

/*
  OpenAI Streaming LLM (invoqué dans Deepgram STT)
*/
async function promptLLM(mediaStream, prompt) {
  const stream = openai.beta.chat.completions.stream({
    model: 'gpt-3.5-turbo',
    stream: true,
    messages: [
      {
        role: 'assistant',
        content: `You are funny, everything is a joke to you.`
      },
      {
        role: 'user',
        content: prompt
      }
    ],
  });

  speaking = true;
  let firstToken = true;
  for await (const chunk of stream) {
    if (speaking) {
      if (firstToken) {
        const end = Date.now();
        const duration = end - llmStart;
        ttsStart = Date.now();
        console.warn('\n>>> openai LLM: Time to First Token = ', duration, '\n');
        firstToken = false;
        firstByte = true;
      }
      const chunk_message = chunk.choices[0].delta.content;
      if (chunk_message) {
        process.stdout.write(chunk_message);
        if (!send_first_sentence_input_time && containsAnyChars(chunk_message)) {
          send_first_sentence_input_time = Date.now();
        }
        mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ type: 'Speak', text: chunk_message }));
      }
    }
  }
  mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ type: 'Flush' }));
}

function containsAnyChars(str) {
  let strArray = Array.from(str);
  return strArray.some(char => chars_to_check.includes(char));
}

/*
  Deepgram Streaming Text to Speech WebSocket
*/
const setupDeepgramWebsocket = (mediaStream) => {
  const options = {
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`
    }
  };
  const ws = new WebSocket(deepgramTTSWebsocketURL, options);

  ws.on('open', function open() {
    console.log('deepgram TTS: Connected');
  });

  ws.on('message', function incoming(data) {
    if (speaking) {
      try {
        let json = JSON.parse(data.toString());
        console.log('deepgram TTS (message JSON):', data.toString());
        return;
      } catch (e) {
        // Ignorer les erreurs de parsing (le message est probablement binaire audio)
      }
      if (firstByte) {
        const end = Date.now();
        const duration = end - ttsStart;
        console.warn('\n\n>>> deepgram TTS: Time to First Byte = ', duration, '\n');
        firstByte = false;
        if (send_first_sentence_input_time) {
          console.log(`>>> deepgram TTS: Time to First Byte from end of sentence token = `, (end - send_first_sentence_input_time));
        }
      }
      // Envoyer l'audio (payload base64) vers Twilio via WebSocket
      const payload = data.toString('base64');
      const message = {
        event: 'media',
        streamSid: streamSid,
        media: { payload }
      };
      const messageJSON = JSON.stringify(message);
      mediaStream.connection.sendUTF(messageJSON);
    }
  });

  ws.on('close', function close() {
    console.log('deepgram TTS: Disconnected from the WebSocket server');
  });

  ws.on('error', function error(error) {
    console.log("deepgram TTS: error received");
    console.error(error);
  });
  return ws;
};

/*
  Deepgram Streaming Speech to Text
*/
const setupDeepgram = (mediaStream) => {
  let is_finals = [];
  const deepgram = deepgramClient.listen.live({
    model: "nova-2-phonecall",
    language: "en",
    smart_format: true,
    encoding: "mulaw",
    sample_rate: 8000,
    channels: 1,
    multichannel: false,
    no_delay: true,
    interim_results: true,
    endpointing: 300,
    utterance_end_ms: 1000
  });

  if (keepAlive) clearInterval(keepAlive);
  keepAlive = setInterval(() => {
    deepgram.keepAlive();
  }, 10 * 1000);

  deepgram.addListener(LiveTranscriptionEvents.Open, async () => {
    console.log("deepgram STT: Connected");

    deepgram.addListener(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel.alternatives[0].transcript;
      if (transcript !== "") {
        if (data.is_final) {
          is_finals.push(transcript);
          if (data.speech_final) {
            const utterance = is_finals.join(" ");
            is_finals = [];
            console.log(`deepgram STT: [Speech Final] ${utterance}`);
            llmStart = Date.now();
            promptLLM(mediaStream, utterance);
          } else {
            console.log(`deepgram STT:  [Is Final] ${transcript}`);
          }
        } else {
          console.log(`deepgram STT:    [Interim Result] ${transcript}`);
          if (speaking) {
            console.log('twilio: clear audio playback', streamSid);
            const messageJSON = JSON.stringify({
              event: "clear",
              streamSid: streamSid
            });
            mediaStream.connection.sendUTF(messageJSON);
            mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ type: 'Clear' }));
            speaking = false;
          }
        }
      }
    });

    deepgram.addListener(LiveTranscriptionEvents.UtteranceEnd, (data) => {
      if (is_finals.length > 0) {
        console.log("deepgram STT: [Utterance End]");
        const utterance = is_finals.join(" ");
        is_finals = [];
        console.log(`deepgram STT: [Speech Final] ${utterance}`);
        llmStart = Date.now();
        promptLLM(mediaStream, utterance);
      }
    });

    deepgram.addListener(LiveTranscriptionEvents.Close, async () => {
      console.log("deepgram STT: Disconnected");
      clearInterval(keepAlive);
      deepgram.requestClose();
    });

    deepgram.addListener(LiveTranscriptionEvents.Error, async (error) => {
      console.log("deepgram STT: error received");
      console.error(error);
    });

    deepgram.addListener(LiveTranscriptionEvents.Warning, async (warning) => {
      console.log("deepgram STT: warning received");
      console.warn(warning);
    });

    deepgram.addListener(LiveTranscriptionEvents.Metadata, (data) => {
      console.log("deepgram STT: metadata received:", data);
    });
  });

  return deepgram;
};

// Démarrer le serveur HTTP
wsserver.listen(HTTP_SERVER_PORT, function () {
  console.log("Server listening on port %s", HTTP_SERVER_PORT);
});
