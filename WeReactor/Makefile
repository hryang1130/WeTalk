# WeTalk: upstream examples/api/tests are trimmed; only the modules we actually build are kept
SUBDIRS = re_reactor re_dns re_reporter re_lb_agent

.PHONY: all

all:
	@list='$(SUBDIRS)'; for subdir in $$list; do \
		echo "Clean in $$subdir";\
		$(MAKE) -C $$subdir;\
	done

.PHONY: clean

clean:
	@echo Making clean
	@list='$(SUBDIRS)'; for subdir in $$list; do \
		echo "Clean in $$subdir";\
		$(MAKE) -C $$subdir clean;\
	done
