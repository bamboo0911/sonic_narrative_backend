const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');
const { ClarifaiStub, grpc } = require('clarifai-nodejs-grpc');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
require('dotenv').config();

// Initialize OpenAI client
const openai = new OpenAI();

// Initialize Clarifai gRPC client
const clarifaiStub = ClarifaiStub.grpc();
const CLARIFAI_API_KEY = process.env.CLARIFAI_API_KEY;
const USER_ID = process.env.CLARIFAI_USER_ID;
const APP_ID = process.env.CLARIFAI_APP_ID;

if (!CLARIFAI_API_KEY || !USER_ID || !APP_ID) {
  throw new Error('Clarifai API Key, User ID or App ID is missing. Please set these values in the .env file.');
}

// Set up Clarifai metadata
const metadata = new grpc.Metadata();
metadata.set('authorization', 'Key ' + CLARIFAI_API_KEY);

// Initialize Express app
const app = express();
const port = process.env.PORT || 8080;

app.use(cors());
app.use(bodyParser.json({ limit: '15mb' }));
app.use(bodyParser.urlencoded({ limit: '15mb', extended: true }));

let latestGeneratedText = '';

// Input validation
function validateInput(text, photo) {
  console.log('Validating input data...');
  if (!text || typeof text !== 'string') {
    throw new Error('Invalid text input');
  }
  if (!photo || typeof photo !== 'string') {
    throw new Error('Invalid photo input');
  }
  try {
    Buffer.from(photo, 'base64');
    console.log('Photo is a valid Base64 string');
  } catch (e) {
    throw new Error('Photo input is not a valid Base64 string');
  }
}

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    // Check Clarifai API
    await checkClarifaiAPI();
    
    // Check OpenAI API
    await checkOpenAIAPI();
    
    res.json({ status: 'healthy', message: 'All systems operational' });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy', message: error.message });
  }
});

// Clarifai API health check
async function checkClarifaiAPI() {
  return new Promise((resolve, reject) => {
    clarifaiStub.PostModelOutputs(
      {
        user_app_id: {
          user_id: USER_ID,
          app_id: APP_ID,
        },
        model_id: 'general-image-recognition',
        version_id: 'aa7f35c01e0642fda5cf400f543e7c40',
        inputs: [{ data: { image: { url: 'https://samples.clarifai.com/metro-north.jpg' } } }]
      },
      metadata,
      (err, response) => {
        if (err) {
          reject(new Error('Clarifai API check failed'));
        } else if (response.status.code !== 10000) {
          reject(new Error(`Clarifai API check failed: ${response.status.description}`));
        } else {
          resolve();
        }
      }
    );
  });
}

// OpenAI API health check
async function checkOpenAIAPI() {
  try {
    await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 5
    });
  } catch (error) {
    throw new Error('OpenAI API check failed');
  }
}

// Generate poem route
app.post('/api/generate-poem', async (req, res) => {
  const { text, photo } = req.body;

  try {
    console.log('Received request, text content:', text);

    validateInput(text, photo);

    const cleanedPhoto = photo.replace(/^data:image\/\w+;base64,/, '');

    clarifaiStub.PostModelOutputs(
      {
        user_app_id: {
          user_id: USER_ID,
          app_id: APP_ID,
        },
        model_id: 'general-image-recognition',
        inputs: [
          {
            data: {
              image: { base64: cleanedPhoto },
            },
          },
        ],
      },
      metadata,
      async (err, response) => {
        if (err) {
          console.error('Clarifai API call error:', err);
          return res.status(500).json({ error: 'Clarifai API call failed', details: err.message });
        }

        if (response.status.code !== 10000) {
          console.error('Clarifai API call failed, status:', response.status.description);
          return res.status(500).json({ error: 'Clarifai API call failed', details: response.status.description });
        }

        const labels = response.outputs[0].data.concepts.map(concept => concept.name).join(', ');
        console.log('Labels generated from image:', labels);

        const openaiPrompt = `以第一人稱視角創作一篇詩意故事，結合以下照片標籤: ${labels}，以及創作者的文字紀錄: "${text}"。故事需具有深刻的意義，捕捉兩者特質，富有韻律與美感，並且應該追求故事精要簡潔在50字內結束並且有一個完整的結尾。故事必須完整，且不能中斷。`;

        try {
          const completion = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',  // 使用有效的模型ID
            messages: [
              { role: 'system', content: "You are a poetic and insightful assistant. Ensure the story is complete and does not end abruptly." },
              { role: 'user', content: openaiPrompt }
            ],
            max_tokens: 300,
            temperature: 0.8,
            top_p: 0.9,
          });

          latestGeneratedText = completion.choices[0].message.content.trim();
          console.log('Poem generated from OpenAI:', latestGeneratedText);

          res.json({
            generatedText: latestGeneratedText,
          });
        } catch (openaiError) {
          console.error('OpenAI API call error:', openaiError);
          res.status(500).json({
            error: 'OpenAI API call failed',
            details: openaiError.message,
          });
        }
      }
    );
  } catch (error) {
    console.error('/api/generate-poem route error:', error);
    res.status(400).json({ error: 'Invalid input', details: error.message });
  }
});

// Generate audio route
app.post('/api/generate-audio', async (req, res) => {
  const { text, voice = 'alloy', speed = 1.0 } = req.body;  // 接收voice和speed参数，并设置默认值

  try {
    console.log('Received audio generation request, text content:', text);
    console.log('Voice:', voice, 'Speed:', speed);

    if (!text) {
      throw new Error('Text input must be provided to generate audio');
    }

    const speechFile = path.resolve('./speech.mp3');
    console.log('Audio will be saved to:', speechFile);

    const mp3 = await openai.audio.speech.create({
      model: "tts-1",
      voice: voice,
      input: text,
      speed: speed,
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    await fs.promises.writeFile(speechFile, buffer);
    console.log('Speech has been successfully generated and saved');

    const audioBase64 = fs.readFileSync(speechFile, { encoding: 'base64' });
    console.log('Audio has been converted to Base64 string');

    res.json({
      audioContent: audioBase64,
    });

  } catch (error) {
    console.error('/api/generate-audio route error:', error);
    res.status(500).json({ error: 'OpenAI TTS API call failed', details: error.message });
  }
});

// New route to provide the latest generated AI text
app.get('/api/latest-result', (req, res) => {
    if (latestGeneratedText) {
        res.json({ generatedText: latestGeneratedText });
    } else {
        res.status(404).json({ error: 'No AI generated text available.' });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

// Start the server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
