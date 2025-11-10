import path from 'path';
import { authenticateAdmin } from "../config/auth.js";

export function setupStaticRoutes(app, server) {

    // admin login page
    app.get('/admin/login', (req, res) => {
        res.sendFile(path.join(server.__dirname, 'public', 'login.html'));
    });

    // admin panel or dashboard whatever...
    app.get('/admin/dashboard', authenticateAdmin, (req, res) => {
        res.sendFile(path.join(server.__dirname, 'public', 'admin.html'));
    });


    // root endpoint
    app.get('/', (req, res) => {
        res.sendFile(path.join(server.__dirname, 'public', 'index.html'));
    });

}