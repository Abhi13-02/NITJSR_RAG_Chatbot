import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

async function listModels() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('⚠️ Please set GEMINI_API_KEY in your .env');
    process.exit(1);
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

  try {
    const resp = await fetch(url);
    const data = await resp.json();

    if (!resp.ok) {
      console.error('Error listing models:', data);
      return;
    }

    console.log('Available models:');
    if (data.models && Array.isArray(data.models)) {
      data.models.forEach((m, idx) => {
        console.log(`${idx + 1}. ${m.name}`);
      });
    } else {
      console.log('Unexpected response format:', data);
    }
  } catch (err) {
    console.error('Fetch error:', err);
  }
}

listModels();
