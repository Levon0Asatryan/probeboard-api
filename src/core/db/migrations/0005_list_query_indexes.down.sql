DROP INDEX endpoints_service_id_user_id_id_idx;
CREATE INDEX endpoints_service_id_idx ON endpoints (service_id);

DROP INDEX endpoints_user_id_id_idx;
CREATE INDEX endpoints_user_id_idx ON endpoints (user_id);

DROP INDEX services_user_id_id_idx;
CREATE INDEX services_user_id_idx ON services (user_id);
