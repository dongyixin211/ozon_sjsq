CREATE USER ozon_sjsq WITH PASSWORD 'change_this_password';
CREATE DATABASE ozon_sjsq_cloud OWNER ozon_sjsq;
GRANT ALL PRIVILEGES ON DATABASE ozon_sjsq_cloud TO ozon_sjsq;
