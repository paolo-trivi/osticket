// Ambiente dei test: punta all'installazione osTicket di sviluppo creata da dev/setup-osticket.sh
process.env.OST_CONFIG_PATH ??= "/home/user/ost-dev/www/include/ost-config.php";
process.env.APP_SESSION_SECRET ??= "test-secret-test-secret-test-secret-0123";
