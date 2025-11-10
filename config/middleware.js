import express from 'express';
import cors from 'cors';
import path from 'path';
import cookieParser from 'cookie-parser';

export function setupMiddleware(app, __dirname) {
    // CORS configuration
    app.use(
        cors({
            origin:
                process.env.NODE_ENV === 'production'
                    ? ['https://yourdomain.com']
                    : [
                        'http://localhost:3000',
                        'http://127.0.0.1:3000',
                        'http://localhost:5500',
                        'http://127.0.0.1:5500',
                    ],
            credentials: true,
        })
    );

    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true, limit: '10mb' }));
    app.use(cookieParser());

    // Serve static files
    app.use(express.static(path.join(__dirname, 'public')));

    // Request logging middleware
    app.use((req, res, next) => {
        console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
        next();
    });
}



export function setupErrorHandler(app) {
    // 404 error
    app.use('*', (req, res) => {
        res.status(404).json({ success: false, error: 'Endpoint not found' });
    });

    // Error handling middleware (must be after routes)
    app.use((error, req, res, next) => {
        console.error('Server error:', error);
        res.status(500).json({
            success: false,
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
        });
    });
}