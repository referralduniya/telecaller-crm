CREATE DATABASE IF NOT EXISTS telecaller_crm;
USE telecaller_crm;

CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('super_user', 'manager', 'agent') NOT NULL,
    created_by INT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE leads (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    salary VARCHAR(50),
    assigned_to INT NULL,
    uploaded_by INT NOT NULL,
    status ENUM('Pending', 'Connected', 'Off', 'Interested', 'Not Interested', 'Callback') DEFAULT 'Pending',
    final_revert TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (assigned_to) REFERENCES users(id)
);

CREATE TABLE call_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    lead_id INT NOT NULL,
    agent_id INT NOT NULL,
    call_status ENUM('Connected', 'Off', 'Interested', 'Not Interested', 'Callback') NOT NULL,
    final_revert TEXT,
    duration_seconds INT DEFAULT 0,
    called_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (lead_id) REFERENCES leads(id),
    FOREIGN KEY (agent_id) REFERENCES users(id)
);

CREATE TABLE agent_sessions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    agent_id INT NOT NULL,
    login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    logout_time TIMESTAMP NULL,
    FOREIGN KEY (agent_id) REFERENCES users(id)
);
