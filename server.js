// Entry point for Render (and for running on your own computer).
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import app from './src/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Family Expense Tracker running on http://localhost:${PORT}`));
