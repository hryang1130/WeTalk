#pragma once

#include "mysql.h"
#include "re.pb.h"

class StoreReport
{
public:
    StoreReport();

    void store(re::ReportStatusRequest req);

private:
    MYSQL _db_conn;
};


void *store_main(void*);
