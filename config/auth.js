import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const ADMIN_CREDENTIALS = {
    username: process.env.ADMIN_USERNAME || 'admin',
    passwordHash: process.env.ADMIN_PASSWORD_HASH || bcrypt.hashSync('admin123', 10)
};

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = '5h';



// admin login
const login = async (username, password) => {
    if (username !== ADMIN_CREDENTIALS.username) {
        return { success: false, error: 'Invalid credentials' };
    }

    const isValid = await bcrypt.compare(password, ADMIN_CREDENTIALS.passwordHash);
    if (!isValid) {
        return { success: false, error: 'Invalid credentials' };
    }

    const token = jwt.sign(
        { username, role: 'admin' },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRY }
    );

    return { success: true, token };
};



// auth middleware
const authenticateAdmin = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1] || req.cookies?.adminToken;

    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
};



// verify token - if admin is still logged in
const verifyToken = (token) => {
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        return { valid: true, user: decoded };
    } catch (error) {
        return { valid: false };
    }
};


export {
    login,
    authenticateAdmin,
    verifyToken
};
