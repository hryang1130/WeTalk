cmake_minimum_required(VERSION 3.16)
project(wetalk_server CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Threads REQUIRED)
find_package(Boost 1.71 REQUIRED COMPONENTS system date_time filesystem)
# jammy(Ubuntu 22.04) 不发布 boost_uuid 编译库（boost.uuid 头文件在 libboost1.74-dev 内），
# 手工补一个 header-only 的 Boost::uuid 目标，用法不变
if(NOT TARGET Boost::uuid)
    add_library(Boost::uuid INTERFACE IMPORTED)
    target_include_directories(Boost::uuid INTERFACE ${Boost_INCLUDE_DIRS})
endif()
find_package(Protobuf REQUIRED)
find_package(PkgConfig REQUIRED)
pkg_check_modules(GRPC REQUIRED grpc++ grpc)
pkg_check_modules(HIREDIS REQUIRED hiredis)
find_library(MYSQLCPPCONN_LIB mysqlcppconn REQUIRED)
pkg_check_modules(JSONCPP REQUIRED jsoncpp) # jammy 头文件在 /usr/include/jsoncpp/json/json.h

find_program(GRPC_CPP_PLUGIN grpc_cpp_plugin REQUIRED)

set(RE_ACTOR_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../we_reactor)

# ---------- 路由治理实现（we_reactor 内置，自带 CMake，只取 re_proto） ----------
# 服务端只需要 re.pb（治理层消息体 + 返回码）；re_reactor 网络库和三个可执行体
# 都由 docker/Dockerfile.route-* 独立构建，这里关掉以免拉进 MySQL / reactor 依赖。
set(WE_REACTOR_BUILD_BINS OFF CACHE BOOL "we_reactor: 关闭三个可执行体（服务端构建用）" FORCE)
set(WE_REACTOR_BUILD_NET OFF CACHE BOOL "we_reactor: 关闭 re_reactor 网络库（服务端构建用）" FORCE)
add_subdirectory(${RE_ACTOR_DIR} ${CMAKE_CURRENT_BINARY_DIR}/we_reactor)

# ---------- WeTalk 路由治理 API（route_client，自研版；we_reactor 里的旧版 API 实现已剔除，避免同名类符号重复） ----------
add_library(route_api STATIC common/route/route_api.cpp)
target_include_directories(route_api PUBLIC common/route)
target_link_libraries(route_api PUBLIC re_proto)

# ---------- WeTalk 公共组件（WetalkRouteClient：路由治理的线程安全封装） ----------
add_library(wetalk_common STATIC common/WetalkRouteClient.cpp)
target_include_directories(wetalk_common PUBLIC common)
target_link_libraries(wetalk_common PUBLIC route_api)

# ---------- 每个服务的 protobuf/grpc 生成 ----------
function(wetalk_gen_proto SERVICE_DIR OUT_SRCS)
    set(_pb   ${CMAKE_CURRENT_BINARY_DIR}/${SERVICE_DIR}/message.pb.cc)
    set(_ph   ${CMAKE_CURRENT_BINARY_DIR}/${SERVICE_DIR}/message.pb.h)
    set(_grpc ${CMAKE_CURRENT_BINARY_DIR}/${SERVICE_DIR}/message.grpc.pb.cc)
    set(_gh   ${CMAKE_CURRENT_BINARY_DIR}/${SERVICE_DIR}/message.grpc.pb.h)
    add_custom_command(
        OUTPUT ${_pb} ${_ph} ${_grpc} ${_gh}
        COMMAND ${CMAKE_COMMAND} -E make_directory ${CMAKE_CURRENT_BINARY_DIR}/${SERVICE_DIR}
        COMMAND protobuf::protoc
        ARGS --grpc_out=${CMAKE_CURRENT_BINARY_DIR}/${SERVICE_DIR}
             --cpp_out=${CMAKE_CURRENT_BINARY_DIR}/${SERVICE_DIR}
             -I${SERVICE_DIR}
             --plugin=protoc-gen-grpc=${GRPC_CPP_PLUGIN}
             ${SERVICE_DIR}/message.proto
        COMMAND sed -i s/::grpc::internal::CallbackUnaryHandler/::grpc_impl::internal::CallbackUnaryHandler/g ${_gh}
        DEPENDS ${SERVICE_DIR}/message.proto
        COMMENT "Generating protobuf/grpc for ${SERVICE_DIR}")
    set(${OUT_SRCS} ${_pb} ${_grpc} PARENT_SCOPE)
endfunction()

# ---------- 服务可执行文件 ----------
function(add_wetalk_service NAME)
    cmake_parse_arguments(ARG "" "DIR" "" ${ARGN})
    wetalk_gen_proto(${ARG_DIR} GEN)
    file(GLOB SRCS ${ARG_DIR}/*.cpp)
    list(FILTER SRCS EXCLUDE REGEX "message\\.pb\\.cc$|message\\.grpc\\.pb\\.cc$")
    add_executable(${NAME} ${SRCS} ${GEN})
    target_include_directories(${NAME} PRIVATE
        ${ARG_DIR}
        ${CMAKE_CURRENT_SOURCE_DIR}/common
        ${CMAKE_CURRENT_BINARY_DIR}/${ARG_DIR}
        ${CMAKE_CURRENT_BINARY_DIR}
        ${JSONCPP_INCLUDE_DIRS}
        ${HIREDIS_INCLUDE_DIRS}
        /usr/include/mysql-cppconn-8)
    target_link_libraries(${NAME} PRIVATE
        Boost::system Boost::date_time Boost::filesystem Boost::uuid
        protobuf::libprotobuf grpc++ grpc
        ${HIREDIS_LIBRARIES} ${MYSQLCPPCONN_LIB} ${JSONCPP_LIBRARIES}
        wetalk_common route_api Threads::Threads)
endfunction()

add_wetalk_service(gate      DIR ${CMAKE_CURRENT_SOURCE_DIR}/GateServer)
add_wetalk_service(status    DIR ${CMAKE_CURRENT_SOURCE_DIR}/StatusServer)
# VarifyServer 是原作者用 Node.js 写的邮件验证码服务（server.js + @grpc/grpc-js），不走 C++ 构建
add_wetalk_service(chat      DIR ${CMAKE_CURRENT_SOURCE_DIR}/ChatServer)
add_wetalk_service(resource  DIR ${CMAKE_CURRENT_SOURCE_DIR}/ResourceServer)
