import express from 'express';
import { login, verifyToken, authenticateAdmin } from '../config/auth.js';

const router = express.Router();

export function setupAuthRoutes(app) {
    // login
    app.post('/auth/login', async (req, res) => {
        try {
            const { username, password } = req.body;

            if (!username || !password) {
                return res.status(400).json({ error: 'Username and password required' });
            }

            const result = await login(username, password);

            if (!result.success) {
                return res.status(401).json({ error: result.error });
            }

            res.cookie('adminToken', result.token, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                maxAge: 24 * 60 * 60 * 1000
            });

            res.json({
                success: true,
                token: result.token,
                message: 'Login successful'
            });
        } catch (error) {
            console.error('Login error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });



    // verify token
    app.post('/auth/verify', authenticateAdmin, (req, res) => {
        const token = req.body.token || req.cookies?.adminToken;

        if (!token) {
            return res.status(401).json({ valid: false });
        }

        const result = verifyToken(token);
        res.json(result);
    });



    // logout
    app.post('/auth/logout', authenticateAdmin, (req, res) => {
        res.clearCookie('adminToken');
        res.json({ success: true, message: 'Logged out successfully' });
    });



    // testing
    // app.get('/admin/dashboard', authenticateAdmin, (req, res) => {
    //     res.json({
    //         success: true,
    //         message: `Welcome, ${req.user.username}!`,
    //     });
    // });
}