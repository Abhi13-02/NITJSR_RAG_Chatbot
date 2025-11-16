import { Pinecone } from "@pinecone-database/pinecone";
import { CohereClient } from "cohere-ai";
import {fileURLToPath} from "url";
import path from "path";
import dotenv from "dotenv";


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });

const cohere = new CohereClient({
    token: process.env.COHERE_API_KEY
});

async function searchWithCohere() {
    const index = pc.index(process.env.PINECONE_INDEX_NAME);

    const embed = await cohere.embed({
        model: "embed-english-v3.0",
        texts: ["Hello world"],
        inputType: "search_query"
    });

    const vector = embed.embeddings[0];

    const result = await index.query({
        topK: 5,
        includeMetadata: true,
        vector
    });

    console.dir(result, { depth: null });
}

searchWithCohere();
