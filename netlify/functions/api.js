// Netlify Function: runs the Express app from server.js for every /api/* request
const serverless = require('serverless-http');
const app = require('../../server');

exports.handler = serverless(app, {
    // Netlify's request context carries the token server.js needs to clear the display's CDN cache
    request: (req, event, context) => { req.lambdaContext = context; },
});
