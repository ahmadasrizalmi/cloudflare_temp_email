INSERT OR IGNORE INTO users (user_email, password, user_info) VALUES ('ahmadasrizalmi@gmail.com', 'b95a241ef9c41a4ac4cd6594e7bd792a361dfd455ff23964a0180d515a7c654b', '{"userEmail": "ahmadasrizalmi@gmail.com", "geoData": {"ip": "127.0.0.1"}}');
INSERT OR REPLACE INTO user_roles (user_id, role_text) SELECT id, 'admin' FROM users WHERE user_email = 'ahmadasrizalmi@gmail.com';
INSERT OR REPLACE INTO settings (key, value) VALUES ('user_settings', '{"enable": true, "enableMailVerify": false, "maxAddressCount": 10}');
