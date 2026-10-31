// Netlify Function: runs the Express app from server.js for every /api/* request
const serverless = require('serverless-http');
const app = require('../../server');

exports.handler = serverless(app);
