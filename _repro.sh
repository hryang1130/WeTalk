#!/bin/bash
set -e
apt-get update -qq 2>/dev/null
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq build-essential libmysqlclient-dev >/dev/null
cat > /t.c <<'EOF'
#include <stdio.h>
#include <mysql.h>
int main() {
    MYSQL* c = mysql_init(NULL);
    my_bool reconnect = 1;
    mysql_options(c, MYSQL_OPT_CONNECT_TIMEOUT, "30");
    mysql_options(c, MYSQL_OPT_RECONNECT, &reconnect);
    if (!mysql_real_connect(c, "mysql", "root", "123456", "wetalk_route", 3306, NULL, 0)) {
        printf("connect failed: %u %s\n", mysql_errno(c), mysql_error(c));
        return 1;
    }
    printf("connected ok\n");
    return 0;
}
EOF
g++ /t.c -o /t -Dmy_bool=bool $(mysql_config --cflags) /usr/lib/x86_64-linux-gnu/libmysqlclient.a -lssl -lcrypto -lzstd -lm -lresolv -lpthread -ldl -lstdc++
/t
