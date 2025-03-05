const express = require('express');
const puppeteer = require('puppeteer');
const pino = require('pino');
const swaggerUi = require('swagger-ui-express');
const promBundle = require('express-prom-bundle');
const promClient = require('prom-client');
const fs = require('fs');
const YAML = require('yaml');
const path = require('path');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;
const logger = pino({
  transport: {
    target: 'pino-pretty'
  }
});

// Enable CORS for all origins
app.use(cors());

// Clear any existing metrics and create a new registry
promClient.register.clear();

// Setup Prometheus middleware first
const metricsMiddleware = promBundle({
  includeMethod: true,
  includePath: true,
  autoregister: false,
  promRegistry: promClient.register,
  normalizePath: [
    ['^/api/.*', '/api/#val']
  ],
  defaultMetrics: {
    enabled: true,
    config: {
      prefix: 'pdf_service_'
    }
  },
});

app.use(metricsMiddleware);

// Custom metrics
const pdfGenerationDuration = new promClient.Histogram({
  name: 'pdf_service_generation_duration_seconds',
  help: 'Duration of PDF generation in seconds',
  buckets: [0.1, 0.5, 1, 2, 5],
  registers: [promClient.register]
});

const pdfSize = new promClient.Histogram({
  name: 'pdf_service_size_bytes',
  help: 'Size of generated PDFs in bytes',
  buckets: [100000, 500000, 1000000, 5000000, 10000000],
  registers: [promClient.register]
});

const activeRequests = new promClient.Gauge({
  name: 'pdf_service_active_requests',
  help: 'Number of active PDF generation requests',
  registers: [promClient.register]
});

// Initialize browser instance
let browser = null;

async function initBrowser() {
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: '/usr/bin/chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--font-render-hinting=none'
      ]
    });
    logger.info('Browser instance initialized');
  } catch (error) {
    logger.error('Failed to initialize browser:', error);
    process.exit(1);
  }
}

// Graceful shutdown
async function cleanup() {
  if (browser) {
    await browser.close();
    logger.info('Browser instance closed');
  }
  process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

// Middleware
app.use(express.json({limit: '10mb'})); 
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.text({ limit: '10mb' }));
app.use(express.raw({ limit: '10mb' }));

// Setup Swagger
const swaggerDocument = YAML.parse(
  fs.readFileSync(path.join(__dirname, 'swagger.yaml'), 'utf8')
);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Expose metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', promClient.register.contentType);
  res.send(await promClient.register.metrics());
});

// PDF generation endpoint
app.post('/generate-pdf', async (req, res) => {
  const startTime = Date.now();
  activeRequests.inc();

  const { html, options = {} } = req.body;

  if (!html) {
    activeRequests.dec();
    return res.status(400).json({ error: 'HTML content is required' });
  }

  // Set default options
  const pdfOptions = {
    format: 'A4',
    landscape: false,
    printBackground: true,
    margin: {
      top: '0px',
      right: '0px',
      bottom: '0px',
      left: '0px'
    },
    ...options
  };

  let page = null;
  try {
    // Create a new page for this request
    page = await browser.newPage();
    
    // Set viewport size
    await page.setViewport({
      width: options.width || 1200,
      height: options.height || 800
    });

    // Set content with waiting for all resources
    await page.setContent(html, {
      waitUntil: ['networkidle0', 'domcontentloaded']
    });

    // Generate PDF
    const pdf = await page.pdf(pdfOptions);

    // Record metrics
    const duration = (Date.now() - startTime) / 1000;
    pdfGenerationDuration.observe(duration);
    pdfSize.observe(pdf.length);

    res.contentType('application/pdf');
    res.send(pdf);

  } catch (error) {
    logger.error('Error generating PDF:', error);
    res.status(500).json({ error: 'Failed to generate PDF' });
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (error) {
        logger.error('Error closing page:', error);
      }
    }
    activeRequests.dec();
  }
});


app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start the server
async function startServer() {
  await initBrowser();
  app.listen(port, () => {
    logger.info(`PDF service listening at http://localhost:${port}`);
    logger.info(`Swagger UI available at http://localhost:${port}/api-docs`);
    logger.info(`Metrics available at http://localhost:${port}/metrics`);
  });
}

startServer().catch((error) => {
  logger.error('Failed to start server:', error);
  process.exit(1);
}); 