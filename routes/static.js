import path from 'path';

export function setupStaticRoutes(app, server) {

    // Admin endpoint
    app.get('/admin', (req, res) => {
        res.sendFile(path.join(server.__dirname, 'public', 'admin.html'));
    });


    // Root endpoint
    app.get('/', (req, res) => {
        res.sendFile(path.join(server.__dirname, 'public', 'index.html'));
    });

}